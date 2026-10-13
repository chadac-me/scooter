"""The reconcile loop: the imperative shell around reconcile.py.

Lists pods and Conversations, computes per-pod load, decides each conversation's action
and applies the status patch. The caller leader-gates it, and it takes a ControllerK8s
(real or fake) so the whole loop is unit-testable against an in-memory fake."""

from __future__ import annotations

import logging

from dataclasses import dataclass

from .logging_config import forget_warned, warn_once

from .reconcile import (
    ConversationState,
    Assign,
    NoOp,
    LeavePending,
    Detach,
    MarkSuspended,
    reconcile,
    find_orphans,
    desired_replicas,
    deletion_costs,
    demand_of,
    SuspendSandbox,
)

logger = logging.getLogger(__name__)
_C = {"component": "loop"}


def _state(cr: dict, sandbox_modes: dict[str, str | None] | None = None) -> ConversationState:
    st = cr.get("status") or {}
    spec = cr.get("spec") or {}
    ref = spec.get("sandboxRef")
    return ConversationState(
        name=cr["metadata"]["name"],
        host_pod=st.get("hostPod"),
        # None when the Sandbox does not exist, which the drift rule treats as no evidence.
        sandbox_mode=(sandbox_modes or {}).get(ref) if ref else None,
        sandbox_ref=ref,
        creator_pod=spec.get("creatorPod"),
        phase=st.get("phase", "Pending"),
        # Whether the CR carries a phase at all, as opposed to the "Pending" default above.
        phase_present=st.get("phase") is not None,
        generation=int(st.get("generation", 0)),
        host_ip=st.get("hostIP"),
        parent_id=spec.get("parentId"),
    )


def _row_state(row: dict, sandbox_modes: dict[str, str | None], ip_of: dict[str, str]) -> ConversationState:
    ref = row.get("sandbox_ref")
    host = row.get("host_pod")
    return ConversationState(
        name=row["id"],
        host_pod=host,
        sandbox_mode=sandbox_modes.get(ref) if ref else None,
        sandbox_ref=ref,
        creator_pod=row.get("creator_pod"),
        phase=row.get("phase") or "Pending",
        phase_present=row.get("phase") is not None,
        generation=int(row.get("host_generation") or 0),
        host_ip=ip_of.get(host) if host else None,
        parent_id=row.get("parent_id"),
    )


def _patch_cr(k8s, crs: dict | None, name: str, status: dict) -> None:
    """Mirror status onto the CR; with rows as the source, a missing or failed CR is not fatal."""
    if crs is None:
        k8s.patch_status(name, status)
        return
    if name not in crs:
        return
    try:
        k8s.patch_status(name, status)
    except Exception:  # noqa: BLE001
        logger.warning("CR status mirror failed", extra={**_C, "conversation_id": name}, exc_info=True)


def _mirror_noop(k8s, crs: dict | None, c: ConversationState) -> None:
    """Bring a CR's status in line with the row, e.g. after a router claim."""
    if crs is None or c.name not in crs:
        return
    st = crs[c.name]
    want = {"hostPod": c.host_pod, "hostIP": c.host_ip, "generation": c.generation}
    if c.phase_present:
        want["phase"] = c.phase
    if any(st.get(k) != v for k, v in want.items()):
        _patch_cr(k8s, crs, c.name, want)


# Zombie repair state (one controller process, one loop). A zombie is a Suspended, unhosted
# conversation whose Sandbox reads Running; a suspend is issued only on the second consecutive
# sighting, re-issued only after a backoff, and after a bounded number of attempts the leaked
# pod is reclaimed and the conversation marked Failed. The record survives the quiescent half of
# a suspend/resume oscillation so the attempt budget is reached, and is forgotten only once the
# suspend has held for _ZOMBIE_FORGET_TICKS.
_ZOMBIE_CONFIRM_TICKS = 2          # consecutive sightings before the first suspend
_ZOMBIE_SUSPEND_BACKOFF_TICKS = 3  # ticks to wait between suspends
_ZOMBIE_MAX_SUSPENDS = 3           # suspend attempts before the terminal escalation
_ZOMBIE_FORGET_TICKS = 12          # consecutive quiescent ticks before the attempt budget is forgotten


@dataclass
class _ZombieProgress:
    confirms: int = 0       # consecutive ticks reconcile flagged this conversation as a zombie
    suspends: int = 0       # suspend patches issued so far
    cooldown: int = 0       # ticks remaining before the next suspend is allowed
    resolved: bool = False  # terminal escalation done and logged once; take no further action
    quiescent: int = 0      # consecutive ticks the suspend has held


_zombie_progress: dict[str, _ZombieProgress] = {}

# Last tick's generations: a fresh claim gets one tick's grace.
_prev_gen: dict[str, int] = {}


def _mirror_phase(rows, name: str, phase: str) -> None:
    """Mirror a phase the controller just patched onto the CR to the conversations row, if any."""
    if rows is not None:
        rows.set_phase(name, phase)


def _mirror_release(rows, name: str, generation: int) -> None:
    """Mirror a placement release to the row immediately, since a release is a fencing event."""
    if rows is not None:
        rows.release_assignment(name, generation)


def reconcile_once(k8s, cap: int, rows=None) -> list[tuple[str, str]]:
    """One reconcile pass over all Conversations, returning [(name, action_kind)]; load is tracked as assignments are made so a burst of Pending conversations spreads across pods."""
    pods = k8s.list_host_pods()
    # A terminating pod still reports Ready through its grace period, so exclude it here.
    ready_names = {p.name for p in pods if p.ready and not p.terminating}
    # Sandbox listing is best-effort: without it there is no evidence and no drift repair this tick.
    try:
        sandbox_modes = {sb.name: sb.operating_mode for sb in k8s.list_sandboxes()}
    except Exception:  # noqa: BLE001
        logger.warning(
            "list_sandboxes failed", extra={**_C, "skipped": "drift-repair"}, exc_info=True
        )
        sandbox_modes = {}
    crs: dict | None = None
    if rows is not None:
        states = rows.list_states()
        if states is None:
            logger.warning("skipping reconcile: conversations rows unreadable", extra=_C)
            return []
        ip_of = {p.name: p.ip for p in pods}
        convs = [_row_state(r, sandbox_modes, ip_of) for r in states]
        crs = {cr["metadata"]["name"]: (cr.get("status") or {}) for cr in k8s.list_conversations()}
    else:
        convs = [_state(cr, sandbox_modes) for cr in k8s.list_conversations()]

    # Seed load from conversations currently assigned to a still-ready pod.
    load: dict[str, int] = {}
    for c in convs:
        if c.host_pod is not None and c.host_pod in ready_names:
            load[c.host_pod] = load.get(c.host_pod, 0) + 1

    # Current host per conversation so a subagent can co-locate on its parent; parents sort first
    # so a child sees its parent's fresh assignment.
    hosts: dict[str, str | None] = {c.name: c.host_pod for c in convs}
    convs.sort(key=lambda c: c.parent_id is not None)

    results: list[tuple[str, str]] = []
    zombie_flagged: set[str] = set()
    drift_flagged: set[str] = set()
    for c in convs:
        action = reconcile(c, pods, load, cap, hosts)
        if isinstance(action, NoOp):
            _mirror_noop(k8s, crs, c)
            results.append((c.name, "noop"))
            continue
        if isinstance(action, SuspendSandbox):
            zombie_flagged.add(c.name)
            prog = _zombie_progress.setdefault(c.name, _ZombieProgress())

            if prog.resolved:
                results.append((c.name, "zombie-resolved"))
                continue

            prog.confirms += 1

            # A single sighting can be a revive mid-flight, so it is only a suspect.
            if prog.confirms < _ZOMBIE_CONFIRM_TICKS:
                logger.info(
                    "zombie sandbox suspect — confirming next tick",
                    extra={**_C, "conversation_id": c.name, "sandbox": c.sandbox_ref or ""},
                )
                results.append((c.name, "suspend-sandbox-suspect"))
                continue

            if prog.cooldown > 0:
                prog.cooldown -= 1
                results.append((c.name, "suspend-sandbox-backoff"))
                continue

            # Only the pod is reclaimed; deleting the Sandbox CR would cascade the workspace PVC.
            if prog.suspends >= _ZOMBIE_MAX_SUSPENDS:
                if c.sandbox_ref:
                    k8s.reclaim_sandbox_pod(c.sandbox_ref)
                _mirror_phase(rows, c.name, "Failed")
                _patch_cr(k8s, crs, c.name, {"phase": "Failed"})
                prog.resolved = True
                logger.error(
                    "zombie sandbox unresolved — escalating (reclaim the leaked pod + mark conversation Failed)",
                    extra={
                        **_C,
                        "conversation_id": c.name,
                        "sandbox": c.sandbox_ref or "",
                        "suspend_attempts": prog.suspends,
                        "reason": action.reason,
                    },
                )
                results.append((c.name, "zombie-escalated"))
                continue

            prog.suspends += 1
            prog.cooldown = _ZOMBIE_SUSPEND_BACKOFF_TICKS
            logger.warning(
                "zombie sandbox — re-suspending",
                extra={
                    **_C,
                    "conversation_id": c.name,
                    "sandbox": c.sandbox_ref or "",
                    "attempt": prog.suspends,
                    "max_attempts": _ZOMBIE_MAX_SUSPENDS,
                    "reason": action.reason,
                },
            )
            if c.sandbox_ref:
                k8s.suspend_sandbox(c.sandbox_ref)
            results.append((c.name, "suspend-sandbox"))
            continue
        if isinstance(action, Detach):
            # Release stale placement on a suspended conversation, keeping the invariant that
            # hostIP is empty whenever hostPod is empty.
            _mirror_release(rows, c.name, c.generation)
            _patch_cr(k8s, crs, c.name, {"hostPod": None, "hostIP": None})
            hosts[c.name] = None
            results.append((c.name, "detach"))
            continue
        if isinstance(action, MarkSuspended) and crs is not None and _prev_gen.get(c.name) != c.generation:
            results.append((c.name, "drift-grace"))
            continue
        if isinstance(action, MarkSuspended):
            # The Sandbox is Suspended but the phase is not: fix the phase and release placement
            # in one patch, de-duplicating only the log.
            drift_flagged.add(c.name)
            warn_once(
                logger,
                f"phase-drift:{c.name}",
                "phase drift repaired",
                {**_C, "conversation_id": c.name, "reason": action.reason},
            )
            _mirror_phase(rows, c.name, "Suspended")
            _mirror_release(rows, c.name, c.generation)
            _patch_cr(k8s, crs, c.name, {"phase": "Suspended", "hostPod": None, "hostIP": None})
            hosts[c.name] = None
            results.append((c.name, "mark-suspended"))
            continue
        if isinstance(action, LeavePending):
            # Patch unless the CR already says {phase: Pending, hostPod: null}; a status-less CR
            # is patched so its phase materializes.
            if c.host_pod is not None or not c.phase_present or c.phase != "Pending":
                _mirror_phase(rows, c.name, "Pending")
                _mirror_release(rows, c.name, c.generation)
                _patch_cr(k8s, crs, c.name, {"phase": "Pending", "hostPod": None})
            hosts[c.name] = None
            results.append((c.name, "pending"))
            continue
        # Assign / Reassign.
        assert isinstance(action, Assign)
        # The row claim decides; losing to the router is fine.
        if rows is not None and not rows.set_assignment(c.name, action.host_pod, action.generation):
            results.append((c.name, "assign-lost"))
            continue
        _mirror_phase(rows, c.name, action.phase)
        _patch_cr(k8s, crs, c.name, {
            "phase": action.phase,
            "hostPod": action.host_pod,
            "hostIP": action.host_ip,
            "generation": action.generation,
        })
        hosts[c.name] = action.host_pod
        # A subagent shares its parent's pod, so it does not count toward pod capacity.
        if c.parent_id is None:
            load[action.host_pod] = load.get(action.host_pod, 0) + 1
        results.append((c.name, "assign"))
        logger.info(
            "assigned",
            extra={
                **_C,
                "conversation_id": c.name,
                "host_pod": action.host_pod,
                "host_ip": action.host_ip,
                "generation": action.generation,
            },
        )
        # Fire-and-forget revive push so the host hydrates before user traffic arrives; a pod
        # without an IP yet is pushed on the next tick.
        if action.host_ip:
            try:
                k8s.notify_revive(action.host_ip, c.name, action.generation)
            except Exception:  # noqa: BLE001
                logger.warning(
                    "revive-push spawn failed",
                    extra={**_C, "conversation_id": c.name, "fallback": "lazy-revive"},
                    exc_info=True,
                )

    # A conversation that left the zombie state drops its record; one that is merely quiescent
    # (its suspend landed) keeps its attempt budget until the suspend has held long enough.
    quiescent = {
        c.name
        for c in convs
        if c.phase == "Suspended"
        and c.host_pod is None
        and c.host_ip is None
        and c.sandbox_mode == "Suspended"
    }
    for name, prog in list(_zombie_progress.items()):
        if name in zombie_flagged:
            prog.quiescent = 0
            continue
        if name not in quiescent:
            del _zombie_progress[name]
            continue
        prog.confirms = 0
        prog.quiescent += 1
        if prog.quiescent >= _ZOMBIE_FORGET_TICKS:
            del _zombie_progress[name]

    if crs is not None:
        _prev_gen.clear()
        _prev_gen.update({c.name: c.generation for c in convs})

    # Forget conversations that did not drift this pass, so a future drift is logged again.
    forget_warned({f"phase-drift:{n}" for n in drift_flagged})

    return results


class AutoscaleState:
    """Mutable cooldown state the caller owns across ticks (scale-down hysteresis)."""

    def __init__(self) -> None:
        self.last_scale_down: float = 0.0


def autoscale_once(k8s, cfg, state: AutoscaleState, now: float) -> dict:
    """Scale the agent-host Deployment to fit conversation demand and return {demand, current, target, ready_pods, per_pod}; the controller is the only writer of spec.replicas, so no HPA may run alongside it."""
    convs = [_state(cr) for cr in k8s.list_conversations()]
    # Demand counts top-level Pending and Assigned conversations only.
    demand = demand_of(convs)
    pods = k8s.list_host_pods()
    ready_pods = sum(1 for p in pods if p.ready)
    current = k8s.get_agent_host_replicas()

    # Pods hosting live conversations must carry their deletion cost before a scale-down picks
    # victims; patch only on change.
    for pod_name, cost in deletion_costs(pods, convs).items():
        if next((p.deletion_cost for p in pods if p.name == pod_name), None) != cost:
            try:
                k8s.set_pod_deletion_cost(pod_name, cost)
            except Exception:  # noqa: BLE001
                logger.warning("set_pod_deletion_cost failed", extra={**_C, "pod": pod_name}, exc_info=True)

    target = desired_replicas(demand, cfg.pod_cap, cfg.min_replicas, cfg.max_replicas)
    per_pod = (demand / ready_pods) if ready_pods else float(demand)

    if target > current:
        # Scale up immediately, since a Pending conversation is a user waiting for a slot.
        k8s.set_agent_host_replicas(target)
        logger.info(
            "autoscale up",
            extra={**_C, "from_replicas": current, "to_replicas": target, "demand": demand, "pod_cap": cfg.pod_cap},
        )
    elif target < current:
        # Scale down only after the cooldown so a brief dip does not drop a pod.
        if now - state.last_scale_down >= cfg.scale_down_cooldown_seconds:
            k8s.set_agent_host_replicas(target)
            state.last_scale_down = now
            logger.info(
                "autoscale down",
                extra={**_C, "from_replicas": current, "to_replicas": target, "demand": demand, "pod_cap": cfg.pod_cap},
            )

    return {"demand": demand, "current": current, "target": target, "ready_pods": ready_pods, "per_pod": per_pod}


def reap_orphans(k8s, grace_seconds: float) -> list[str]:
    """One reaper pass: delete the whole tree (Sandbox, ServiceAccount, module ConfigMap) of every Sandbox with no owning Conversation that is older than the grace window, and return the reaped names."""
    referenced: set[str] = {
        ref
        for cr in k8s.list_conversations()
        if (ref := (cr.get("spec") or {}).get("sandboxRef"))
    }
    orphans = find_orphans(k8s.list_sandboxes(), referenced, grace_seconds)
    reaped: list[str] = []
    for name in orphans:
        try:
            k8s.delete_sandbox_tree(name)
            reaped.append(name)
            logger.info(
                "reaped orphaned sandbox", extra={**_C, "sandbox_name": name, "reason": "no owning Conversation"}
            )
        except Exception:  # noqa: BLE001

            logger.exception(
                "reap of orphaned sandbox failed",
                extra={**_C, "sandbox_name": name, "will_retry_next_pass": True},
            )
    return reaped
