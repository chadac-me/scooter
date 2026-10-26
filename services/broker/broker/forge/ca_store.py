"""Where the forge CA lives: its key in a Secret only the broker reads, its public half in a ConfigMap sandboxes mount.

Every broker replica must sign with the same CA, so the first replica creates it
and the rest adopt it. A changed host set (a new GHES or self-hosted GitLab)
regenerates it, and the resourceVersion-guarded replace lets exactly one replica win.
Sandboxes pick up a regenerated CA on their next start.
"""

from __future__ import annotations

import base64
import logging

from kubernetes import client
from kubernetes.client.exceptions import ApiException

from .ca import CaMaterial, ca_hosts, generate_ca

logger = logging.getLogger(__name__)

NAME = "scooter-forge-ca"


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _material(secret: client.V1Secret) -> CaMaterial | None:
    data = secret.data or {}
    if "ca.crt" not in data or "ca.key" not in data:
        return None
    return CaMaterial(base64.b64decode(data["ca.crt"]), base64.b64decode(data["ca.key"]))


def load_or_create_ca(core: client.CoreV1Api, namespace: str, hosts: list[str]) -> CaMaterial:
    """The deployment's forge CA for exactly `hosts`, creating or regenerating it as needed, and its public ConfigMap kept in step."""
    want = sorted(set(hosts))
    for _ in range(5):
        try:
            secret = core.read_namespaced_secret(NAME, namespace)
        except ApiException as e:
            if e.status != 404:
                raise
            secret = None

        current = _material(secret) if secret is not None else None
        if current is not None and ca_hosts(current.cert_pem) == want:
            _publish(core, namespace, current, want)
            return current

        fresh = generate_ca(want)
        body = client.V1Secret(
            metadata=client.V1ObjectMeta(
                name=NAME,
                namespace=namespace,
                labels={"app.kubernetes.io/part-of": "scooter", "app.kubernetes.io/component": "forge-proxy"},
                resource_version=secret.metadata.resource_version if secret is not None else None,
            ),
            type="Opaque",
            data={"ca.crt": _b64(fresh.cert_pem), "ca.key": _b64(fresh.key_pem)},
        )
        try:
            if secret is None:
                core.create_namespaced_secret(namespace, body)
            else:
                core.replace_namespaced_secret(NAME, namespace, body)
        except ApiException as e:
            # Another replica won the race: adopt whatever it wrote.
            if e.status == 409:
                continue
            raise
        logger.info(
            "forge CA %s", "created" if secret is None else "regenerated for a new host set",
            extra={"hosts": want},
        )
        _publish(core, namespace, fresh, want)
        return fresh
    raise RuntimeError("could not settle the forge CA after repeated conflicts")


def _publish(core: client.CoreV1Api, namespace: str, ca: CaMaterial, hosts: list[str]) -> None:
    """Write the public cert and the intercepted hosts where sandboxes mount them; never the key."""
    data = {"ca.crt": ca.cert_pem.decode(), "hosts": "\n".join(hosts) + "\n"}
    body = client.V1ConfigMap(
        metadata=client.V1ObjectMeta(
            name=NAME,
            namespace=namespace,
            labels={"app.kubernetes.io/part-of": "scooter", "app.kubernetes.io/component": "forge-proxy"},
        ),
        data=data,
    )
    try:
        existing = core.read_namespaced_config_map(NAME, namespace)
    except ApiException as e:
        if e.status != 404:
            raise
        try:
            core.create_namespaced_config_map(namespace, body)
        except ApiException as ce:
            if ce.status != 409:
                raise
        return
    if (existing.data or {}) != data:
        body.metadata.resource_version = existing.metadata.resource_version
        try:
            core.replace_namespaced_config_map(NAME, namespace, body)
        except ApiException as e:
            # A concurrent replica published the same CA; nothing to do.
            if e.status != 409:
                raise
