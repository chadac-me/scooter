"""Leader election via a coordination.k8s.io/v1 Lease, so the controller can run several
replicas while only one reconciles.

The Lease is best-effort fencing: two brief leaders would at worst double-patch the same
row idempotently, and the single-writer guarantee for the log is the row's
host_pod/host_generation rather than this Lease."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from kubernetes import client

from .k8s import _apis

logger = logging.getLogger(__name__)
_C = {"component": "leader"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class LeaderElector:
    """Hand-rolled leader election over a single coordination.k8s.io/v1 Lease.

    :param namespace: the k8s namespace the Lease lives in.
    :param lease_name: name of the Lease all replicas contend for.
    :param identity: this replica's holder identity written into the Lease.
    :param lease_seconds: lease duration a holder must renew within, or another replica may take it.
    """

    namespace: str
    lease_name: str
    identity: str
    lease_seconds: int = 15

    def try_acquire_or_renew(self) -> bool:
        """Acquire a free or expired Lease or renew a held one, returning True iff this replica holds it afterwards."""
        _, _, coord = _apis()
        try:
            lease = coord.read_namespaced_lease(self.lease_name, self.namespace)
        except client.ApiException as e:
            if e.status == 404:
                return self._create()
            raise

        spec = lease.spec
        holder = spec.holder_identity
        renew = spec.renew_time
        expired = (
            renew is None
            or (_now() - renew.replace(tzinfo=timezone.utc)).total_seconds()
            > (spec.lease_duration_seconds or self.lease_seconds)
        )
        if holder == self.identity or expired:
            return self._update(lease)
        return False

    def _create(self) -> bool:
        _, _, coord = _apis()
        body = client.V1Lease(
            metadata=client.V1ObjectMeta(name=self.lease_name, namespace=self.namespace),
            spec=client.V1LeaseSpec(
                holder_identity=self.identity,
                lease_duration_seconds=self.lease_seconds,
                acquire_time=_now(),
                renew_time=_now(),
            ),
        )
        try:
            coord.create_namespaced_lease(self.namespace, body)
            logger.info(
                "acquired lease",
                extra={**_C, "lease_name": self.lease_name, "identity": self.identity, "via": "create"},
            )
            return True
        except client.ApiException as e:
            if e.status == 409:
                return False
            raise

    def _update(self, lease) -> bool:
        _, _, coord = _apis()
        acquiring = lease.spec.holder_identity != self.identity
        lease.spec.holder_identity = self.identity
        lease.spec.lease_duration_seconds = self.lease_seconds
        lease.spec.renew_time = _now()
        if acquiring:
            lease.spec.acquire_time = _now()
        try:
            coord.replace_namespaced_lease(self.lease_name, self.namespace, lease)
            if acquiring:
                logger.info(
                    "acquired lease",
                    extra={**_C, "lease_name": self.lease_name, "identity": self.identity, "via": "takeover"},
                )
            return True
        except client.ApiException as e:
            if e.status == 409:

                return False
            raise
