"""Sizing: the policies are pure, and the actuator enforces caps and cooldown."""

from warm_store_controller.allocate import PoolPv
from warm_store_controller.sizing import (
    ActuatorConfig,
    ActuatorState,
    Event,
    FixedPolicy,
    ReactivePolicy,
    Retire,
    Snapshot,
    StartWarm,
    combine,
    p90,
    plan,
    split_by_node,
)

NOW = 100_000.0


def snap(**kw) -> Snapshot:
    return Snapshot(now=NOW, current_tag="t", **kw)


def idle(name, pool="warm", tag="t", node=None) -> PoolPv:
    terms = [{"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": [node]}]}] if node else []
    return PoolPv(name=name, image_tag=tag, phase="Available", pool=pool, node_selector_terms=terms)


def test_fixed_policy_is_min_warm():
    assert FixedPolicy(3).target(snap()) == {("t", None): 3}


def test_reactive_with_no_traffic_is_the_floor():
    assert ReactivePolicy(1, 8).target(snap()) == {("t", None): 1}


def test_reactive_scales_with_arrivals_and_lead():
    # ceil(6 arrivals / 900s * 300s lead * 1.5) = 3.
    arrivals = [Event(NOW - 60 * i, "t") for i in range(6)]
    t = ReactivePolicy(1, 8).target(snap(arrivals=arrivals, warm_job_seconds=[300.0]))
    assert t == {("t", None): 3}


def test_reactive_adds_misses_and_ignores_old_events_and_other_tags():
    arrivals = [Event(NOW - 10, "t"), Event(NOW - 5000, "t"), Event(NOW - 10, "other")]
    misses = [Event(NOW - 10, "t"), Event(NOW - 10, "t")]
    t = ReactivePolicy(0, 8).target(snap(arrivals=arrivals, misses=misses, warm_job_seconds=[300.0]))
    assert t == {("t", None): 1 + 2}


def test_reactive_is_capped():
    arrivals = [Event(NOW - 1, "t")] * 500
    assert ReactivePolicy(1, 4).target(snap(arrivals=arrivals)) == {("t", None): 4}


def test_split_by_node_is_proportional_and_sums_to_total():
    out = split_by_node("t", 4, ["a", "a", "a", "b"])
    assert out == {("t", "a"): 3, ("t", "b"): 1}
    assert sum(split_by_node("t", 5, ["a", "b", None]).values()) == 5


def test_combine_takes_the_max():
    assert combine({("t", None): 2}, {("t", None): 5, ("t", "a"): 1}) == {("t", None): 5, ("t", "a"): 1}


def test_p90():
    assert p90([]) is None
    assert p90([float(i) for i in range(1, 11)]) == 9.0


def test_grow_respects_max_warm_jobs():
    out = plan(snap(), {("t", None): 5}, [], ActuatorConfig(max_warm_jobs=2), ActuatorState(), {})
    assert out == [StartWarm("t", None), StartWarm("t", None)]


def test_grow_counts_in_flight_jobs_and_idle_returned_pvs():
    s = snap(pvs=[idle("r", pool="returned")])
    out = plan(s, {("t", None): 3}, [None], ActuatorConfig(max_warm_jobs=5), ActuatorState(), {"r": NOW})
    assert out == [StartWarm("t", None)]


def test_grow_pins_to_the_neediest_node():
    s = snap(pvs=[idle("a1", node="a")])
    out = plan(s, {("t", "a"): 1, ("t", "b"): 2}, [], ActuatorConfig(max_warm_jobs=5), ActuatorState(), {})
    assert out == [StartWarm("t", "b"), StartWarm("t", "b")]


def test_shrink_waits_for_cooldown_then_retires_one_coldest():
    s = snap(pvs=[idle("w1"), idle("w2"), idle("w3")])
    cfg = ActuatorConfig(cooldown=60)
    state = ActuatorState()
    released = {"w1": 3.0, "w2": 1.0, "w3": 2.0}
    assert plan(s, {("t", None): 1}, [], cfg, state, released) == []
    later = Snapshot(now=NOW + 61, current_tag="t", pvs=s.pvs)
    assert plan(later, {("t", None): 1}, [], cfg, state, released) == [Retire("w2", "shrink")]


def test_dipping_below_target_resets_the_cooldown():
    state = ActuatorState(above_since=NOW - 10_000)
    plan(snap(), {("t", None): 1}, [], ActuatorConfig(), state, {})
    assert state.above_since is None


def test_returned_pool_is_capped_by_ttl_and_count():
    pvs = [idle(f"r{i}", pool="returned") for i in range(4)]
    released = {"r0": NOW - 100_000, "r1": NOW - 30, "r2": NOW - 20, "r3": NOW - 10}
    cfg = ActuatorConfig(max_returned=2, returned_ttl=86_400)
    out = plan(snap(pvs=pvs), {("t", None): 0}, [], cfg, ActuatorState(), released)
    assert Retire("r0", "returned-ttl") in out
    assert Retire("r1", "returned-cap") in out
    assert len([a for a in out if isinstance(a, Retire)]) == 2


def test_a_promoting_warm_pv_stops_further_warming():
    """#973: a warm PVC held by pvc-protection must not trigger another warm Job."""
    from warm_store_controller import janitor as j

    pvc = j.Pvc("warm-store-t-1", "Bound", "pv9", "pool", {j.LBL_WARM_SEED: "true", "scooter.io/warm-store": "t"},
                terminating=True)
    pv = PoolPv("pv9", image_tag="t", phase="Bound", claim_ref="warm-store-t-1")
    world = j.World(pvs=[pv], pvcs={pvc.name: pvc}, sandboxes={}, mounted=set(), warm_jobs={}, markers={})
    _, warming = j.plan_upkeep(world, j.UpkeepConfig(current_tag="t", pool_class="pool"), NOW, {})
    out = plan(snap(pvs=[pv]), {("t", None): 1}, warming, ActuatorConfig(max_warm_jobs=2), ActuatorState(), {})
    assert out == []
