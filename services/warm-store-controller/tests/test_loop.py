"""A whole pass against the in-memory fake."""

import threading

from warm_store_controller import janitor as j
from warm_store_controller.loop import MAX_RETIRES_PER_PASS, PassState, reconcile_once
from warm_store_controller.reserve import Misses
from warm_store_controller.sizing import ActuatorConfig, FixedPolicy

from .fakes import FakeK8s, raw_pv

UPKEEP = j.UpkeepConfig(current_tag="t", pool_class="pool")


def run(k, policy=FixedPolicy(0)):
    reconcile_once(k, UPKEEP, policy, ActuatorConfig(), PassState(), Misses(), threading.Lock())
    return k.calls


def test_a_retire_backlog_drains_a_few_per_pass():
    k = FakeK8s(pvs=[raw_pv(f"leak{i}", phase="Released", claim=f"scooter-rw-conv-{i}", uid="u") for i in range(15)])
    assert len([c for c in run(k) if c[0] == "retire"]) == MAX_RETIRES_PER_PASS


def test_a_clean_release_is_recycled_and_counts_toward_the_target():
    clean = raw_pv(
        "pv1", phase="Released", claim="scooter-rw-conv-a", uid="u",
        labels={"scooter.io/warm-store": "t"}, annotations={"scooter.io/shutdown": "clean"},
    )
    calls = run(FakeK8s(pvs=[clean]), FixedPolicy(2))
    assert ("recycle", "pv1", "returned") in calls
    # The recycled PV already counts toward the floor of 2.
    assert [c for c in calls if c[0] == "start-warm"] == [("start-warm", "t", None)]


def test_non_pool_pvs_are_ignored():
    other = raw_pv("ws", sc="local-path", phase="Released", claim="workspace-conv-a", uid="u")
    assert run(FakeK8s(pvs=[other])) == []
