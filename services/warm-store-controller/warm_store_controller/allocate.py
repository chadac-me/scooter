"""PV placement: the pure decision core for handing a sandbox a warm overlay upper.

The controller pre-creates the PVC the sandbox's vct will adopt, pre-bound via `claimRef`,
and placing nothing is valid because the vct then provisions a fresh upper.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field

# Ownership marker, since ownerReferences cannot own a cluster-scoped PV.
PV_FINALIZER = "scooter.io/warm-store"

LBL_WARM_STORE = "scooter.io/warm-store"      # image content tag, the version key
ANN_LAST_USED = "scooter.io/last-used"        # rfc3339, for LRU


@dataclass(frozen=True)
class PoolPv:
    """A pool PV as the controller sees it."""

    name: str
    image_tag: str
    phase: str                       # Available | Bound | Released | Failed
    node_selector_terms: list[dict] = field(default_factory=list)  # spec.nodeAffinity's required terms, verbatim
    last_used: str | None = None
    claim_ref: str | None = None     # spec.claimRef.name when reserved/bound
    terminating: bool = False


@dataclass(frozen=True)
class Node:
    """A schedulable node, reduced to the labels a PV's nodeAffinity can match on."""

    name: str
    labels: dict[str, str]
    schedulable: bool = True


@dataclass(frozen=True)
class PendingSandbox:
    """A Sandbox awaiting an upper, where `pvc_name` is exactly what its vct will generate."""

    sandbox: str
    image_tag: str
    pvc_name: str


# --- the placement predicate ----------------------------------------------

def node_matches(terms: list[dict], node: Node) -> bool:
    """Whether `node` satisfies a PV's nodeSelectorTerms, with terms OR'd and expressions AND'd."""
    if not terms:
        return True
    for term in terms:
        exprs = term.get("matchExpressions") or []
        fields = term.get("matchFields") or []
        # matchFields keys on node metadata, not labels, so the term cannot be evaluated.
        if fields:
            continue
        if all(_expr_matches(e, node) for e in exprs):
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


def usable_pvs(pvs: list[PoolPv], nodes: list[Node], image_tag: str) -> list[PoolPv]:
    """Pool PVs that could serve a sandbox of `image_tag` right now: matching tag, Available, not terminating, unreserved and reachable from a schedulable node."""
    live = [n for n in nodes if n.schedulable]
    return [
        pv
        for pv in pvs
        if pv.image_tag == image_tag
        and pv.phase == "Available"
        and not pv.terminating
        and pv.claim_ref is None
        and any(node_matches(pv.node_selector_terms, n) for n in live)
    ]


def candidates_for(
    want: PendingSandbox,
    pvs: list[PoolPv],
    nodes: list[Node],
    affinity: dict[str, str] | None = None,
) -> Iterator[PoolPv]:
    """PVs this sandbox could use, best-first; claim() decides freeness."""
    usable = usable_pvs(pvs, nodes, want.image_tag)
    mine = (affinity or {}).get(want.sandbox)
    for pv in usable:
        if pv.name == mine:
            yield pv
            break
    # An undated PV sorts last, and name breaks ties for a stable order.
    for pv in sorted(usable, key=lambda p: (p.last_used or "", p.name), reverse=True):
        if pv.name != mine:
            yield pv
