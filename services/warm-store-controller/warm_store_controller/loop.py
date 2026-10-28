"""One controller pass: observe, plan upkeep and sizing, then apply.

Any failure degrades to sandboxes provisioning a fresh upper, so per-action errors are
logged and skipped rather than aborting the pass.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field, replace

from kubernetes.client.exceptions import ApiException

from . import janitor as j
from .k8s import ControllerK8s, node_terms, now_rfc3339
from .allocate import PoolPv
from .reserve import Misses
from .sizing import (
    ActuatorConfig,
    ActuatorState,
    Event,
    Retire,
    SizingPolicy,
    Snapshot,
    StartWarm,
    plan,
)

logger = logging.getLogger("loop")

WARM_HISTORY = 50
# Each wipe is a helper pod; backlogs drain across passes.
MAX_RETIRES_PER_PASS = 10


@dataclass
class PassState:
    """What the leader remembers between passes; a new leader starts fresh."""

    marker_attempts: dict[str, int] = field(default_factory=dict)
    warm_seconds: list[float] = field(default_factory=list)
    actuator: ActuatorState = field(default_factory=ActuatorState)


def reconcile_once(
    k8s: ControllerK8s,
    upkeep: j.UpkeepConfig,
    policy: SizingPolicy,
    actuator: ActuatorConfig,
    state: PassState,
    misses: Misses,
    lock: threading.Lock,
    clock=time,
) -> None:
    raw = k8s.list_pvs()
    pvs = k8s.pool_pvs(raw)
    pvcs = k8s.list_pvcs()
    sandboxes = k8s.list_sandboxes()
    warm_jobs, seconds = k8s.warm_jobs()
    world = j.World(
        pvs=pvs,
        pvcs=pvcs,
        sandboxes=sandboxes,
        mounted=k8s.mounted_claims(),
        warm_jobs=warm_jobs,
        markers=k8s.marker_jobs(),
    )
    for s in seconds:
        if s not in state.warm_seconds:
            state.warm_seconds.append(s)
    del state.warm_seconds[:-WARM_HISTORY]

    now = clock.time()
    actions, warming = j.plan_upkeep(world, upkeep, now, state.marker_attempts)
    retires = [a for a in actions if isinstance(a, j.RetirePv)]
    if len(retires) > MAX_RETIRES_PER_PASS:
        skip = {id(a) for a in retires[MAX_RETIRES_PER_PASS:]}
        actions = [a for a in actions if id(a) not in skip]
        logger.info("retire backlog; continuing next pass", extra={"pending": len(skip)})
    touched: set[str] = set()
    for a in actions:
        try:
            _apply(k8s, a, lock, state, touched)
        except Exception:  # noqa: BLE001
            logger.exception("upkeep action failed", extra={"action": type(a).__name__, "target": _target(a)})

    # Drop attempt counts for releases that finished.
    releasing = {n for n, p in pvcs.items() if p.labels.get(j.LBL_RELEASE) == "requested"}
    for pvc in list(state.marker_attempts):
        if pvc not in releasing:
            del state.marker_attempts[pvc]

    # Count PVs recycled this pass as idle, so none warm twice.
    recycled = [
        replace(a.pv, phase="Available", pool=a.pool, claim_ref=None, claim_uid=None, released_at=now_rfc3339())
        for a in actions if isinstance(a, j.Recycle) and a.pv.name in touched
    ]
    snap = Snapshot(
        now=now,
        current_tag=upkeep.current_tag,
        arrivals=_arrivals(sandboxes, pvcs, raw),
        misses=misses.recent(),
        pvs=[pv for pv in pvs if pv.name not in touched] + recycled,
        warm_job_seconds=list(state.warm_seconds),
    )
    target = policy.target(snap)
    released = {pv.name: j.epoch(pv.released_at) for pv in snap.pvs}
    for a in plan(snap, target, warming, actuator, state.actuator, released):
        try:
            if isinstance(a, StartWarm):
                name = k8s.start_warm(a.tag, a.node)
                logger.info("warming a pool PV", extra={"pvc": name, "image_tag": a.tag, "node": a.node, "target": _total(target)})
            elif isinstance(a, Retire):
                pv = next(p for p in snap.pvs if p.name == a.pv)
                with lock:
                    k8s.retire(pv)
                logger.info("retired a pool PV", extra={"pv": a.pv, "reason": a.reason})
        except ApiException:
            logger.exception("sizing action failed", extra={"action": type(a).__name__})


def _apply(k8s: ControllerK8s, a: j.Action, lock: threading.Lock, state: PassState, touched: set[str]) -> None:
    if isinstance(a, j.LabelPv):
        with lock:
            k8s.label_bound(a.pv, a.tag, a.last_sandbox, a.drop_shutdown)
        touched.add(a.pv.name)
    elif isinstance(a, j.Recycle):
        with lock:
            k8s.recycle(a.pv, a.pool)
        touched.add(a.pv.name)
        logger.info("returned a PV to the pool", extra={"pv": a.pv.name, "pool": a.pool, "last_sandbox": a.pv.last_sandbox})
    elif isinstance(a, j.RetirePv):
        with lock:
            k8s.retire(a.pv)
        touched.add(a.pv.name)
        logger.info("retired a pool PV", extra={"pv": a.pv.name, "reason": a.reason})
    elif isinstance(a, j.ClearReservation):
        with lock:
            k8s.clear_reservation(a.pv)
        touched.add(a.pv.name)
        logger.info("cleared a stale reservation", extra={"pv": a.pv.name, "pvc": a.pv.claim_ref})
    elif isinstance(a, j.Unrelease):
        k8s.set_pvc_label(a.pvc, j.LBL_RELEASE, None)
        k8s.delete_marker_jobs(a.pvc)
        logger.info("sandbox resumed; keeping its PV", extra={"pvc": a.pvc})
    elif isinstance(a, j.DeletePvc):
        k8s.delete_pvc(a.pvc)
        logger.info("deleted a PVC", extra={"pvc": a.pvc, "reason": a.reason})
    elif isinstance(a, j.DropRelease):
        _drop_release(k8s, a, lock)
    elif isinstance(a, j.StartMarkerCheck):
        k8s.start_marker_check(a.pvc)
        state.marker_attempts[a.pvc] = state.marker_attempts.get(a.pvc, 0) + 1
        logger.info("checking the clean-shutdown marker", extra={"pvc": a.pvc, "attempt": state.marker_attempts[a.pvc]})
    elif isinstance(a, j.MarkerUnknown):
        k8s.delete_marker_jobs(a.pvc)
        logger.warning("clean-shutdown marker unreadable; will retry", extra={"pvc": a.pvc})
    elif isinstance(a, j.FinishRelease):
        _finish_release(k8s, a, lock)
        touched.add(a.pv)
    elif isinstance(a, j.PromoteWarm):
        k8s.mark_clean(a.pv)
        # The Job's pod holds the PVC (pvc-protection) until it goes.
        k8s.delete_warm_jobs(a.pvc)
        k8s.delete_pvc(a.pvc)
        touched.add(a.pv)
        logger.info("warm PV ready", extra={"pv": a.pv, "pvc": a.pvc})


def _still_released(k8s: ControllerK8s, name: str) -> j.Pvc | None:
    """The PVC if it still awaits release and its sandbox has not resumed."""
    pvc = k8s.read_pvc(name)
    if pvc is None or pvc.labels.get(j.LBL_RELEASE) != "requested":
        return None
    sandbox = j.sandbox_of(name)
    sb = k8s.read_sandbox(sandbox) if sandbox else None
    return None if sb is not None and not sb.suspended else pvc


def _drop_release(k8s: ControllerK8s, a: j.DropRelease, lock: threading.Lock) -> None:
    """Re-check under the reserve lock, so a resume that raced the pass keeps its PVC."""
    with lock:
        if _still_released(k8s, a.pvc) is None:
            return
        k8s.delete_pvc(a.pvc)
    logger.info("deleted a PVC", extra={"pvc": a.pvc, "reason": a.reason})


def _finish_release(k8s: ControllerK8s, a: j.FinishRelease, lock: threading.Lock) -> None:
    """Re-check under the reserve lock, so a resume that raced the check keeps its PVC."""
    with lock:
        pvc = _still_released(k8s, a.pvc)
        if pvc is None or pvc.volume_name != a.pv:
            return
        if a.clean:
            k8s.mark_clean(a.pv)
        else:
            k8s.retire_bound(a.pv)
        k8s.delete_pvc(a.pvc)
    k8s.delete_marker_jobs(a.pvc)
    logger.info("released a PV", extra={"pvc": a.pvc, "pv": a.pv, "clean": a.clean, "reason": a.reason})


def _arrivals(sandboxes: dict[str, j.Sandbox], pvcs: dict[str, j.Pvc], raw: list[dict]) -> list[Event]:
    """Sandbox creations, each on the node its workspace PV pins it to, if known yet."""
    pv_node: dict[str, str | None] = {}
    for pv in raw:
        name = pv["metadata"]["name"]
        pv_node[name] = PoolPv(name=name, node_selector_terms=node_terms(pv)).node
    out: list[Event] = []
    for sb in sandboxes.values():
        ws = pvcs.get(f"workspace-{sb.name}")
        node = pv_node.get(ws.volume_name) if ws is not None and ws.volume_name else None
        out.append(Event(sb.created_at, sb.tag, node))
    return out


def _total(target: dict) -> int:
    return sum(target.values())


def _target(a: j.Action) -> str | None:
    pv = getattr(a, "pv", None)
    if isinstance(pv, PoolPv):
        return pv.name
    return pv or getattr(a, "pvc", None)
