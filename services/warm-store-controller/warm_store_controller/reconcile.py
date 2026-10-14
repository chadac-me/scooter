"""The pure reconcile core: decides the set of pool actions given the current PVCs and
Sandboxes, with no k8s and no I/O.

A pool PVC is a writable overlay upper on an RWO PVC, keyed by the sandbox image tag it
was warmed against and claimable only by a sandbox with a matching tag; its pool-state is
one of warming, ready, claimed or retiring. The controller owns top-up, GC,
return-on-suspend and leak recovery, while the agent-host provisioner does the claim
out-of-band and the controller only observes the resulting `claimed-by` label.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

# State of a `warming` PVC's warm Job, resolved by the shell.
WarmJobStatus = Literal["succeeded", "failed", "running"]


# --- Observed state ---------------------------------------------------------

@dataclass(frozen=True)
class PoolPvc:
    """A pool PVC as the controller sees it, from its labels and bound state."""

    name: str
    image_tag: str            # label scooter.io/warm-store, the version key
    state: str                # label scooter.io/pool-state: warming|ready|claimed|retiring
    claimed_by: str | None = None   # label scooter.io/claimed-by (conv id) when claimed
    last_used: str | None = None    # annotation scooter.io/last-used (rfc3339) for LRU
    bound_to_pod: bool = False       # a live pod currently mounts it
    terminating: bool = False        # metadata.deletionTimestamp is set, so it is already resolved
    warm_job_status: WarmJobStatus | None = None  # for a `warming` PVC, its warm Job's state


@dataclass(frozen=True)
class SandboxRef:
    """A per-conversation Sandbox the controller watches for return and leak signals."""

    conv_id: str              # the conversation id, matching claimed-by on its pooled PVC
    image_tag: str            # the sandbox's image content tag
    suspended: bool           # operatingMode != Running
    # The clean-shutdown marker, meaningful only when suspended: "clean" returns the PVC, "unclean"
    # (definitively absent) discards it, and "unknown" (could not read) backs off.
    unmount_marker: Literal["clean", "unclean", "unknown"] = "clean"


@dataclass(frozen=True)
class PoolConfig:
    """Pool knobs, from the kubenix options."""

    current_image_tag: str    # the sandbox image tag new conversations get
    min_ready: int = 1        # top up until this many `ready` PVCs exist for current_image_tag
    max_total: int = 8        # cap on pool PVCs for the current tag, LRU-evicting `ready` past it


# --- Actions the shell will apply -----------------------------------------

@dataclass(frozen=True)
class WarmNew:
    """Create a fresh warming PVC and launch a warm Job against it for `image_tag`."""
    image_tag: str


@dataclass(frozen=True)
class Relabel:
    """Set the PVC's pool-state label plus optional extra labels."""
    pvc: str
    state: str
    labels: dict[str, str | None] = field(default_factory=dict)


@dataclass(frozen=True)
class DeletePvc:
    """Delete a PVC for the given reason."""
    pvc: str
    reason: str


Action = WarmNew | Relabel | DeletePvc


CLAIMED_BY = "scooter.io/claimed-by"


def reconcile(
    pvcs: list[PoolPvc],
    sandboxes: list[SandboxRef],
    cfg: PoolConfig,
) -> list[Action]:
    """Decide the pool actions for one pass, at most one per PVC: a claimed PVC is considered for return, leak recovery or discard, a ready one for GC then LRU eviction, and only then is the current tag topped up toward min_ready."""
    actions: list[Action] = []
    sandbox_by_conv = {s.conv_id: s for s in sandboxes}

    # Current-tag `ready` PVCs surviving this pass (including ones returned this pass), and
    # in-flight warming ones, both count toward min_ready.
    surviving_ready: list[PoolPvc] = []
    in_flight_warming = 0

    for p in pvcs:
        # A terminating PVC is already resolved; top-up below warms a replacement.
        if p.terminating:
            continue

        if p.state == "claimed":
            # A pod still holds the RWO PVC, and relabeling it could let a second pod double-mount.
            if p.bound_to_pod:
                continue
            sbox = sandbox_by_conv.get(p.claimed_by) if p.claimed_by else None
            if sbox is not None and sbox.suspended:
                # Return-on-suspend keyed on the unmount marker; "unknown" backs off and retries.
                if sbox.unmount_marker == "clean":
                    actions.append(Relabel(pvc=p.name, state="ready", labels={CLAIMED_BY: None}))
                    if p.image_tag == cfg.current_image_tag:
                        surviving_ready.append(p)
                elif sbox.unmount_marker == "unclean":
                    actions.append(DeletePvc(pvc=p.name, reason="unclean-return"))
            elif sbox is None:
                # Leak recovery: the owning Sandbox is gone and no pod holds it.
                actions.append(Relabel(pvc=p.name, state="ready", labels={CLAIMED_BY: None}))
                if p.image_tag == cfg.current_image_tag:
                    surviving_ready.append(p)
            continue

        if p.state == "ready":
            # A ready PVC for a retired tag is GC'd, since its lower is gone.
            if p.image_tag != cfg.current_image_tag:
                actions.append(DeletePvc(pvc=p.name, reason="retired-tag"))
                continue
            surviving_ready.append(p)
            continue

        if p.state == "warming":
            # Promote or discard on the warm Job's terminal state.
            if p.image_tag != cfg.current_image_tag:
                actions.append(DeletePvc(pvc=p.name, reason="retired-tag"))
            elif p.warm_job_status == "succeeded":
                actions.append(Relabel(pvc=p.name, state="ready"))
                surviving_ready.append(p)
            elif p.warm_job_status == "failed":
                actions.append(DeletePvc(pvc=p.name, reason="warm-failed"))
            else:
                in_flight_warming += 1
            continue

    # LRU-evict current-tag `ready` PVCs past max_total, coldest first.
    if len(surviving_ready) > cfg.max_total:
        # A missing last_used sorts oldest; name breaks ties for determinism.
        by_age = sorted(surviving_ready, key=lambda p: (p.last_used or "", p.name))
        evict = by_age[: len(surviving_ready) - cfg.max_total]
        for p in evict:
            actions.append(DeletePvc(pvc=p.name, reason="lru-evict"))
        surviving_ready = by_age[len(surviving_ready) - cfg.max_total :]

    # Top up the current tag toward min_ready after evictions, counting in-flight warms.
    deficit = cfg.min_ready - len(surviving_ready) - in_flight_warming
    for _ in range(max(0, deficit)):
        actions.append(WarmNew(image_tag=cfg.current_image_tag))

    return actions
