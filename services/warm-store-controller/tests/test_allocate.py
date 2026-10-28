"""Claim order: own PV first, then warm, then returned longest-idle first."""

from warm_store_controller.allocate import Node, PoolPv, allowed_nodes, claim_order

N1 = Node("n1", {"kubernetes.io/hostname": "n1"})
N2 = Node("n2", {"kubernetes.io/hostname": "n2"})


def _on(node: str) -> list[dict]:
    return [{"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": [node]}]}]


def pv(name, pool="returned", *, tag="t", node="n1", released=None, last=None, **kw) -> PoolPv:
    return PoolPv(
        name=name, image_tag=tag, phase=kw.pop("phase", "Available"), pool=pool,
        node_selector_terms=_on(node), released_at=released, last_sandbox=last, **kw,
    )


def order(pvs, sandbox="conv-a", tag="t", nodes=(N1, N2)):
    return [p.name for p in claim_order(sandbox, tag, list(pvs), list(nodes))]


def test_own_pv_first_then_warm_then_oldest_returned():
    pvs = [
        pv("new", released="2026-10-27T10:00:00Z", last="conv-b"),
        pv("old", released="2026-10-26T10:00:00Z", last="conv-c"),
        pv("warm", pool="warm", released="2026-10-27T11:00:00Z"),
        pv("mine", released="2026-10-27T11:30:00Z", last="conv-a"),
    ]
    assert order(pvs) == ["mine", "warm", "old", "new"]


def test_only_idle_pvs_of_the_tag_are_candidates():
    pvs = [
        pv("other-tag", tag="old"),
        pv("reserved", claim_ref="scooter-rw-conv-x"),
        pv("bound", phase="Bound", claim_ref="scooter-rw-conv-a", last="conv-a"),
        pv("unpooled", pool=None),
        pv("going", terminating=True),
        pv("ok"),
    ]
    assert order(pvs) == ["ok"]


def test_a_bound_own_pv_is_never_taken():
    pvs = [pv("mine", phase="Bound", claim_ref="scooter-rw-conv-z", last="conv-a"), pv("other")]
    assert order(pvs) == ["other"]


def test_resume_is_limited_to_the_workspace_node():
    pvs = [pv("on-n1", pool="warm", node="n1"), pv("on-n2", pool="warm", node="n2")]
    nodes = allowed_nodes([N1, N2], _on("n2"))
    assert order(pvs, nodes=nodes) == ["on-n2"]


def test_cordoned_nodes_are_not_allowed():
    cordoned = Node("n1", {"kubernetes.io/hostname": "n1"}, schedulable=False)
    assert order([pv("a", node="n1")], nodes=allowed_nodes([cordoned, N2], None)) == []


def test_node_reads_the_hostname_pin():
    assert pv("a", node="n7").node == "n7"
    assert PoolPv(name="b").node is None
