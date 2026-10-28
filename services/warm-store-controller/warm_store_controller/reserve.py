"""`/reserve`: pre-bind an idle pool PV to a sandbox's overlay PVC before its pod exists.

Reservations and the pass's PV writes share one lock, so the leader never races itself;
the resourceVersion CAS on every PV write covers anything else.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass

from kubernetes.client.exceptions import ApiException

from .allocate import allowed_nodes, claim_order
from .janitor import LBL_RELEASE, OVERLAY_PREFIX
from .k8s import ControllerK8s, node_terms
from .sizing import Event

logger = logging.getLogger("reserve")

MAX_CAS_ATTEMPTS = 3


@dataclass(frozen=True)
class Result:
    pv: str | None
    pool: str | None
    reason: str


class Misses:
    """Recent reservations that found nothing, for the sizing policy."""

    def __init__(self, keep_seconds: float = 3600.0, clock=time) -> None:
        self._keep = keep_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._events: deque[Event] = deque()

    def record(self, tag: str, node: str | None) -> None:
        with self._lock:
            self._events.append(Event(self._clock.time(), tag, node))

    def recent(self) -> list[Event]:
        with self._lock:
            cutoff = self._clock.time() - self._keep
            while self._events and self._events[0].at < cutoff:
                self._events.popleft()
            return list(self._events)


class Reserver:
    def __init__(self, k8s: ControllerK8s, lock: threading.Lock, misses: Misses) -> None:
        self._k8s = k8s
        self._lock = lock
        self._misses = misses

    def reserve(self, sandbox: str, tag: str) -> Result:
        start = time.monotonic()
        with self._lock:
            waited = time.monotonic() - start
            result, node = self._reserve(sandbox, tag)
        if result.pv is None and result.reason == "miss":
            self._misses.record(tag, node)
        logger.info(
            "reserve",
            extra={
                "sandbox": sandbox, "image_tag": tag, "pv": result.pv, "pool": result.pool, "reason": result.reason,
                "duration_ms": round(1000 * (time.monotonic() - start)), "lock_wait_ms": round(1000 * waited),
            },
        )
        return result

    def _reserve(self, sandbox: str, tag: str) -> tuple[Result, str | None]:
        k = self._k8s
        pvc_name = f"{OVERLAY_PREFIX}{sandbox}"
        # A resume during the release check keeps its PVC.
        k.set_pvc_label(pvc_name, LBL_RELEASE, None)
        # An older marker result must not judge the next suspend.
        k.delete_marker_jobs(pvc_name)

        raw = k.list_pvs()
        pvs = k.pool_pvs(raw)
        for pv in pvs:
            if pv.claim_ref == pvc_name and not pv.terminating and pv.reclaim_policy != "Delete":
                return Result(pv.name, pv.pool, "already-reserved"), None

        pvc = k.read_pvc(pvc_name)
        if pvc is not None and pvc.volume_name:
            return Result(pvc.volume_name, None, "already-bound"), None
        if pvc is not None and pvc.storage_class != k.pool_storage_class:
            return Result(None, None, "not-pool-class"), None

        # On resume the workspace PV already fixes the node.
        workspace = next(
            (pv for pv in raw if (pv["spec"].get("claimRef") or {}).get("name") == f"workspace-{sandbox}"),
            None,
        )
        nodes = allowed_nodes(k.list_nodes(), node_terms(workspace) if workspace is not None else None)
        node = nodes[0].name if workspace is not None and len(nodes) == 1 else None

        tried = 0
        for pv in claim_order(sandbox, tag, pvs, nodes):
            if tried >= MAX_CAS_ATTEMPTS:
                break
            tried += 1
            try:
                k.reserve(pv, pvc_name)
            except ApiException as e:
                if e.status == 409:
                    continue
                raise
            reason = "own" if pv.last_sandbox == sandbox else pv.pool or "pool"
            return Result(pv.name, pv.pool, reason), node
        return Result(None, None, "miss"), node

