"""Controller configuration: a plain value dataclass that `Config.from_env()` reads from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Config:
    """Runtime configuration for the warm-store controller.

    :param namespace: the k8s namespace the pool PVCs and Sandboxes live in.
    :param current_image_tag: the sandbox image tag new conversations get, which the pool keeps warm.
    :param min_ready: top up until this many `ready` PVCs exist for current_image_tag.
    :param max_total: cap on `ready` pool PVCs for the current tag, LRU-evicting past it.
    :param warm_job_image: the sandbox image the warm Job boots.
    :param warm_golden_expr: a Nix expression the warm Job builds into the overlay, or empty for a minimal warm.
    :param overlay_storage: size of each pool PVC.
    :param pool_storage_class: the pool StorageClass, which must have reclaimPolicy Retain (empty means no PV placement).
    :param reconcile_interval: seconds between reconcile passes, which must stay well under lease_seconds.
    :param lease_seconds: leader-election Lease duration the holder must renew within.
    :param lease_name: name of the leader-election Lease shared across replicas.
    :param identity: this replica's lease holder identity, the downward-API pod name.
    """

    namespace: str = "agent-sandbox"
    current_image_tag: str = ""
    min_ready: int = 1
    max_total: int = 8
    warm_job_image: str = ""
    warm_golden_expr: str = ""
    overlay_storage: str = "20Gi"
    pool_storage_class: str = ""
    runtime_class: str = ""
    user_namespace: bool = False
    reconcile_interval: float = 10.0
    lease_seconds: int = 30
    lease_name: str = "warm-store-controller-leader"
    identity: str = "unknown"

    @classmethod
    def from_env(cls) -> "Config":
        """Build a Config from environment variables (the in-cluster path)."""
        sandbox_image = os.environ.get("SANDBOX_IMAGE", "")
        # The pool version key is derived from SANDBOX_IMAGE, the same ref the provisioner
        # keys on, so the two always agree; SANDBOX_IMAGE_TAG is an explicit override only.
        from .k8s import _tag_of
        current_image_tag = os.environ.get("SANDBOX_IMAGE_TAG", "") or _tag_of(sandbox_image)
        return cls(
            namespace=os.environ.get("NAMESPACE", "agent-sandbox"),
            current_image_tag=current_image_tag,
            min_ready=int(os.environ.get("WARM_STORE_MIN_READY", "1")),
            max_total=int(os.environ.get("WARM_STORE_MAX_TOTAL", "8")),
            warm_job_image=sandbox_image,
            warm_golden_expr=os.environ.get("WARM_STORE_GOLDEN_EXPR", ""),
            overlay_storage=os.environ.get("WARM_STORE_STORAGE", "20Gi"),
            pool_storage_class=os.environ.get("WARM_STORE_STORAGE_CLASS", ""),
            runtime_class=os.environ.get("SANDBOX_RUNTIME_CLASS", ""),
            user_namespace=os.environ.get("SANDBOX_USER_NAMESPACE", "") == "1",
            reconcile_interval=float(os.environ.get("RECONCILE_INTERVAL_SECONDS", "10")),
            lease_seconds=int(os.environ.get("LEASE_DURATION_SECONDS", "30")),
            lease_name=os.environ.get("LEASE_NAME", "warm-store-controller-leader"),
            identity=os.environ.get("POD_NAME", "unknown"),
        )
