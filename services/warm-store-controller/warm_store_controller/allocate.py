"""Claim order: the pure core of `/reserve`, choosing which idle pool PV a sandbox gets.

A sandbox takes its own previous PV if it is still idle, otherwise the oldest idle PV:
warm PVs first, then returned PVs longest-idle first. A just-released PV is therefore
the last one handed out, which is what lets its owner usually get it back on resume.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field

LBL_WARM_STORE = "scooter.io/warm-store"      # image tag the upper was built against
LBL_POOL = "scooter.io/pool"                  # warm | returned, on Available PVs
ANN_LAST_SANDBOX = "scooter.io/last-sandbox"  # the sandbox that last used this PV
ANN_RELEASED_AT = "scooter.io/released-at"    # rfc3339, when the PV joined its pool
ANN_RESERVED_AT = "scooter.io/reserved-at"    # rfc3339, when /reserve pre-bound it
ANN_SHUTDOWN = "scooter.io/shutdown"          # "clean" once the marker check passed

POOL_WARM = "warm"
POOL_RETURNED = "returned"


@dataclass(frozen=True)
class PoolPv:
    """A PV on the pool StorageClass, as the controller sees it."""

    name: str
    image_tag: str = ""
    phase: str = ""                  # Available | Bound | Released | Failed
    pool: str | None = None
    node_selector_terms: list[dict] = field(default_factory=list)
    claim_ref: str | None = None     # spec.claimRef.name
    claim_uid: str | None = None     # set once bound; absent on a pre-bind
    last_sandbox: str | None = None
    released_at: str | None = None
    reserved_at: str | None = None
    shutdown_clean: bool = False
    reclaim_policy: str = "Retain"
    terminating: bool = False
    resource_version: str = ""

    @property
    def idle(self) -> bool:
        """Free to hand out: Available, unreserved and in a pool."""
        return (
            self.phase == "Available"
            and self.claim_ref is None
            and not self.terminating
            and self.pool in (POOL_WARM, POOL_RETURNED)
        )

    @property
    def node(self) -> str | None:
        """The hostname a node-local PV is pinned to, or None."""
        for term in self.node_selector_terms:
            for e in term.get("matchExpressions") or []:
                values = e.get("values") or []
                if e.get("key") == "kubernetes.io/hostname" and e.get("operator") == "In" and len(values) == 1:
                    return values[0]
        return None


@dataclass(frozen=True)
class Node:
    """A node, reduced to the labels a PV's nodeAffinity can match on."""

    name: str
    labels: dict[str, str]
    schedulable: bool = True


def node_matches(terms: list[dict], node: Node) -> bool:
    """Whether `node` satisfies nodeSelectorTerms: terms OR'd, expressions AND'd."""
    if not terms:
        return True
    for term in terms:
        # matchFields keys on node metadata, not labels, so the term cannot be evaluated.
        if term.get("matchFields"):
            continue
        if all(_expr_matches(e, node) for e in term.get("matchExpressions") or []):
            return True
    return False


def _expr_matches(expr: dict, node: Node) -> bool:
    key, op = expr.get("key", ""), expr.get("operator", "")
    values = expr.get("values") or []
    actual = node.labels.get(key)
    if op == "In":
        return actual is not None and actual in values
    if op == "NotIn":
        return actual is None or actual not in values
    if op == "Exists":
        return key in node.labels
    if op == "DoesNotExist":
        return key not in node.labels
    return False  # an unknown operator fails closed


def allowed_nodes(nodes: list[Node], workspace_terms: list[dict] | None) -> list[Node]:
    """Schedulable nodes the sandbox can land on, given its workspace PV's affinity."""
    return [n for n in nodes if n.schedulable and node_matches(workspace_terms or [], n)]


def claim_order(
    sandbox: str,
    image_tag: str,
    pvs: list[PoolPv],
    nodes: list[Node],
) -> Iterator[PoolPv]:
    """Idle PVs `sandbox` could use on `nodes`, best first."""
    usable = [
        pv for pv in pvs
        if pv.idle
        and pv.image_tag == image_tag
        and any(node_matches(pv.node_selector_terms, n) for n in nodes)
    ]
    own = [pv for pv in usable if pv.last_sandbox == sandbox]
    yield from own
    # Never-owned warm PVs sort before any returned PV.
    rest = sorted(
        (pv for pv in usable if pv.last_sandbox != sandbox),
        key=lambda p: (p.pool != POOL_WARM, p.released_at or "", p.name),
    )
    yield from rest
