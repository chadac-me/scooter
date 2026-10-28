"""Pool sizing: signals in, a target per (tag, node) out, and the actuator's plan.

The policy is a pure function of a `Snapshot`, so a new policy (time of day, a calendar,
a pre-warm before a rollout) plugs in without touching allocation or the actuator. The
actuator alone enforces `max_warm`, `max_warm_jobs` and the shrink cooldown.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field
from typing import Protocol

from .allocate import POOL_RETURNED, POOL_WARM, PoolPv

# (image tag, node hostname or None for "any node")
Key = tuple[str, str | None]


@dataclass(frozen=True)
class Event:
    """A timestamped arrival or miss."""

    at: float
    tag: str
    node: str | None = None


@dataclass(frozen=True)
class Snapshot:
    """Everything a policy may look at, gathered once per pass."""

    now: float
    current_tag: str
    arrivals: list[Event] = field(default_factory=list)
    misses: list[Event] = field(default_factory=list)
    pvs: list[PoolPv] = field(default_factory=list)
    warm_job_seconds: list[float] = field(default_factory=list)


class SizingPolicy(Protocol):
    def target(self, snap: Snapshot) -> dict[Key, int]:
        """Desired idle PVs per (tag, node)."""
        ...


@dataclass(frozen=True)
class FixedPolicy:
    """Always `min_warm` for the current tag, on any node."""

    min_warm: int

    def target(self, snap: Snapshot) -> dict[Key, int]:
        return {(snap.current_tag, None): self.min_warm}


@dataclass(frozen=True)
class ReactivePolicy:
    """Expected arrivals over one warm-Job lead time, plus recent misses."""

    min_warm: int
    max_warm: int
    window: float = 900.0
    headroom: float = 1.5
    default_lead: float = 300.0

    def target(self, snap: Snapshot) -> dict[Key, int]:
        since = snap.now - self.window
        arrivals = [a for a in snap.arrivals if a.at >= since and a.tag == snap.current_tag]
        misses = sum(1 for m in snap.misses if m.at >= since and m.tag == snap.current_tag)
        lead = p90(snap.warm_job_seconds) or self.default_lead
        rate = len(arrivals) / self.window
        total = math.ceil(rate * lead * self.headroom) + misses
        total = max(self.min_warm, min(self.max_warm, total))
        return split_by_node(snap.current_tag, total, [a.node for a in arrivals])


def p90(xs: list[float]) -> float | None:
    """The 90th percentile by nearest rank, or None for no data."""
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, math.ceil(0.9 * len(s)) - 1)]


def split_by_node(tag: str, total: int, nodes: list[str | None]) -> dict[Key, int]:
    """Share `total` across nodes in proportion to arrivals, by largest remainder."""
    counts = Counter(nodes)
    if not counts or total <= 0:
        return {(tag, None): total}
    n = sum(counts.values())
    exact = {node: total * c / n for node, c in counts.items()}
    out = {node: math.floor(v) for node, v in exact.items()}
    left = total - sum(out.values())
    # Break ties on node name for a deterministic split.
    for node in sorted(exact, key=lambda k: (out[k] - exact[k], k or ""))[:left]:
        out[node] += 1
    return {(tag, node): c for node, c in out.items() if c > 0}


def combine(*targets: dict[Key, int]) -> dict[Key, int]:
    """Compose policies by taking the largest target per key."""
    out: dict[Key, int] = {}
    for t in targets:
        for k, v in t.items():
            out[k] = max(out.get(k, 0), v)
    return out


# --- the actuator ------------------------------------------------------------

@dataclass(frozen=True)
class StartWarm:
    """Launch a warm Job, pinned to `node` when set."""

    tag: str
    node: str | None


@dataclass(frozen=True)
class Retire:
    """Wipe an idle PV."""

    pv: str
    reason: str


@dataclass(frozen=True)
class ActuatorConfig:
    max_warm: int = 8
    max_warm_jobs: int = 2
    cooldown: float = 1800.0
    max_returned: int = 5
    returned_ttl: float = 86400.0


@dataclass
class ActuatorState:
    """Memory across passes: when the pool first exceeded its target."""

    above_since: float | None = None


def plan(
    snap: Snapshot,
    target: dict[Key, int],
    warming: list[str | None],
    cfg: ActuatorConfig,
    state: ActuatorState,
    released_epoch: dict[str, float],
) -> list[StartWarm | Retire]:
    """Grow or shrink the current tag's idle PVs toward `target`.

    :param warming: the pinned node (or None) of each warm Job still running.
    :param released_epoch: PV name to when it joined its pool, in epoch seconds.
    """
    tag = snap.current_tag
    out: list[StartWarm | Retire] = []
    idle = [pv for pv in snap.pvs if pv.idle and pv.image_tag == tag]
    warm = [pv for pv in idle if pv.pool == POOL_WARM]
    returned = [pv for pv in snap.pvs if pv.idle and pv.pool == POOL_RETURNED]

    # Returned PVs are capped by age and count regardless.
    retired: set[str] = set()
    by_age = sorted(returned, key=lambda p: (released_epoch.get(p.name, 0.0), p.name))
    for pv in by_age:
        if snap.now - released_epoch.get(pv.name, 0.0) > cfg.returned_ttl:
            out.append(Retire(pv.name, "returned-ttl"))
            retired.add(pv.name)
    alive = [pv for pv in by_age if pv.name not in retired]
    for pv in alive[: max(0, len(alive) - cfg.max_returned)]:
        out.append(Retire(pv.name, "returned-cap"))
        retired.add(pv.name)

    mine = {k: v for k, v in target.items() if k[0] == tag}
    want = min(cfg.max_warm, sum(mine.values()))
    have_idle = sum(1 for pv in idle if pv.name not in retired)
    have = have_idle + len(warming)

    if have < want:
        state.above_since = None
        slots = max(0, cfg.max_warm_jobs - len(warming))
        on_node = Counter(pv.node for pv in idle if pv.name not in retired) + Counter(warming)
        for _ in range(min(want - have, slots)):
            node = _neediest(mine, on_node)
            out.append(StartWarm(tag, node))
            on_node[node] += 1
        return out

    if have_idle > want and warm:
        if state.above_since is None:
            state.above_since = snap.now
        if snap.now - state.above_since >= cfg.cooldown:
            # One per pass, coldest first, so the pool cannot flap.
            coldest = min(warm, key=lambda p: (released_epoch.get(p.name, 0.0), p.name))
            out.append(Retire(coldest.name, "shrink"))
    else:
        state.above_since = None
    return out


def _neediest(target: dict[Key, int], have: Counter) -> str | None:
    """The node whose target is furthest above what it has, or None for any node."""
    best: str | None = None
    gap = 0
    for (_, node), want in sorted(target.items(), key=lambda kv: kv[0][1] or ""):
        d = want - have.get(node, 0)
        if d > gap:
            best, gap = node, d
    return best
