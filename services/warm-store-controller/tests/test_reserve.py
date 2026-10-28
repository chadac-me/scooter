"""/reserve: idempotent, node-aware, CAS-retrying, and a miss is counted."""

import threading

from warm_store_controller import janitor as j
from warm_store_controller.loop import _finish_release
from warm_store_controller.reserve import Misses, Reserver

from .fakes import FakeK8s, raw_pv

POOLED = {"scooter.io/warm-store": "t", "scooter.io/pool": "warm"}


def reserver(k):
    misses = Misses()
    return Reserver(k, threading.Lock(), misses), misses


def test_reserves_an_idle_pv_and_clears_a_pending_release():
    k = FakeK8s(pvs=[raw_pv("pv1", labels=POOLED)])
    r, misses = reserver(k)
    res = r.reserve("conv-a", "t")
    assert (res.pv, res.pool, res.reason) == ("pv1", "warm", "warm")
    assert ("reserve", "pv1", "scooter-rw-conv-a") in k.calls
    assert ("label-pvc", "scooter-rw-conv-a", j.LBL_RELEASE, None) in k.calls
    assert misses.recent() == []


def test_a_retry_returns_the_same_pv():
    k = FakeK8s(pvs=[raw_pv("pv1", labels=POOLED, claim="scooter-rw-conv-a"), raw_pv("pv2", labels=POOLED)])
    r, _ = reserver(k)
    res = r.reserve("conv-a", "t")
    assert (res.pv, res.reason) == ("pv1", "already-reserved")
    assert not [c for c in k.calls if c[0] == "reserve"]


def test_resume_only_takes_a_pv_on_the_workspace_node():
    k = FakeK8s(pvs=[
        raw_pv("ws", sc="local-path", node="n2", phase="Bound", claim="workspace-conv-a", uid="u"),
        raw_pv("on-n1", labels=POOLED, node="n1"),
        raw_pv("on-n2", labels=POOLED, node="n2"),
    ])
    r, _ = reserver(k)
    assert r.reserve("conv-a", "t").pv == "on-n2"


def test_a_cas_conflict_moves_to_the_next_candidate():
    k = FakeK8s(pvs=[raw_pv("pv1", labels=POOLED), raw_pv("pv2", labels=POOLED)])
    k.conflicts = {"pv1"}
    r, _ = reserver(k)
    assert r.reserve("conv-a", "t").pv == "pv2"


def test_no_candidate_is_a_miss_on_the_workspace_node():
    k = FakeK8s(pvs=[raw_pv("ws", sc="local-path", node="n2", phase="Bound", claim="workspace-conv-a", uid="u")])
    r, misses = reserver(k)
    res = r.reserve("conv-a", "t")
    assert (res.pv, res.reason) == (None, "miss")
    assert [(m.tag, m.node) for m in misses.recent()] == [("t", "n2")]


def test_a_legacy_pvc_is_not_a_miss():
    legacy = j.Pvc("scooter-rw-conv-a", "Pending", None, "local-path")
    k = FakeK8s(pvs=[raw_pv("pv1", labels=POOLED)], pvcs=[legacy])
    r, misses = reserver(k)
    assert r.reserve("conv-a", "t").reason == "not-pool-class"
    assert misses.recent() == []


def test_finish_release_backs_off_when_the_sandbox_resumed():
    pvc = j.Pvc("scooter-rw-conv-a", "Bound", "pv1", "pool", {j.LBL_RELEASE: "requested"})
    k = FakeK8s(pvcs=[pvc], sandboxes=[j.Sandbox("conv-a", "t", suspended=False)])
    _finish_release(k, j.FinishRelease(pvc.name, "pv1", True, "clean"), threading.Lock())
    assert ("delete-pvc", pvc.name) not in k.calls


def test_finish_release_marks_clean_or_wipes():
    pvc = j.Pvc("scooter-rw-conv-a", "Bound", "pv1", "pool", {j.LBL_RELEASE: "requested"})
    k = FakeK8s(pvcs=[pvc], sandboxes=[j.Sandbox("conv-a", "t", suspended=True)])
    _finish_release(k, j.FinishRelease(pvc.name, "pv1", True, "clean"), threading.Lock())
    assert k.calls[:2] == [("mark-clean", "pv1"), ("delete-pvc", pvc.name)]

    k = FakeK8s(pvcs=[pvc], sandboxes=[j.Sandbox("conv-a", "t", suspended=True)])
    _finish_release(k, j.FinishRelease(pvc.name, "pv1", False, "unclean-shutdown"), threading.Lock())
    assert k.calls[:2] == [("retire-bound", "pv1"), ("delete-pvc", pvc.name)]
