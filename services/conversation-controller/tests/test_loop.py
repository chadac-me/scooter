"""Tier 1: the reconcile loop against a fake k8s with in-memory CRs and pods, no cluster."""

from dataclasses import replace as dc_replace

import pytest

import conversation_controller.loop as loop_mod
from conversation_controller.logging_config import forget_warned
from conversation_controller.loop import reconcile_once, reap_orphans, reap_overlays, autoscale_once, AutoscaleState
from conversation_controller.reconcile import Pod, SandboxRef


@pytest.fixture(autouse=True)
def _reset_zombie_state():
    """Reset the zombie repair's module-level per-conversation state between tests."""
    for attr in ("_zombie_progress", "_zombie_suspects", "_prev_gen"):
        state = getattr(loop_mod, attr, None)
        if state is not None:
            state.clear()
    forget_warned()
    yield
    for attr in ("_zombie_progress", "_zombie_suspects", "_prev_gen"):
        state = getattr(loop_mod, attr, None)
        if state is not None:
            state.clear()


class FakeK8s:
    """In-memory Conversations and agent-host pods, where patch_status merges into status."""

    def __init__(self, pods, convs, sandboxes=None, replicas=2):
        self._pods = pods                       # list[Pod]
        self._convs = {c["metadata"]["name"]: c for c in convs}
        self._sandboxes = {s.name: s for s in (sandboxes or [])}  # name -> SandboxRef
        self._replicas = replicas               # agent-host Deployment spec.replicas
        self.scale_calls = []                   # [replicas] per set_agent_host_replicas
        self.patches = []                       # [(name, status)]
        self.revives = []                       # [(host_ip, conv_name, generation)]
        self.deleted_trees = []                 # [sandbox_name] reaped
        self.cost_calls = []                    # [(pod, cost)] per set_pod_deletion_cost
        self.suspends = []                      # [sandbox_name] per suspend_sandbox
        self.reclaimed = []                     # [sandbox_name] per reclaim_sandbox_pod
        self.pvcs = set()                       # PVC names
        self.deleted_pvcs = []                  # [pvc_name] per delete_pvc

    def set_pod_deletion_cost(self, name, cost):
        self.cost_calls.append((name, cost))

    def suspend_sandbox(self, name):
        self.suspends.append(name)

    def reclaim_sandbox_pod(self, name):
        # Like the real reclaim, this re-asserts Suspended and leaves the Sandbox CR in place.
        self.reclaimed.append(name)
        sb = self._sandboxes.get(name)
        if sb is not None:
            self._sandboxes[name] = dc_replace(sb, operating_mode="Suspended")

    def get_agent_host_replicas(self):
        return self._replicas

    def set_agent_host_replicas(self, n):
        self.scale_calls.append(n)
        self._replicas = n

    def list_host_pods(self):
        return list(self._pods)

    def list_conversations(self):
        return list(self._convs.values())

    def list_sandboxes(self):
        return list(self._sandboxes.values())

    def list_pvc_names(self):
        return set(self.pvcs)

    def delete_pvc(self, name):
        if name == "scooter-rw-conv-boom":
            raise RuntimeError("apiserver hiccup")
        self.deleted_pvcs.append(name)
        self.pvcs.discard(name)

    def delete_sandbox_tree(self, name):
        self.deleted_trees.append(name)
        self._sandboxes.pop(name, None)

    def patch_status(self, name, status):
        self.patches.append((name, status))
        # Like the apiserver, a null status materializes into an object on first patch.
        cur = self._convs[name].get("status")
        if cur is None:
            cur = {}
            self._convs[name]["status"] = cur
        cur.update({k: v for k, v in status.items()})

    def notify_revive(self, host_ip, conv_name, generation):
        self.revives.append((host_ip, conv_name, generation))

    # test helpers
    def status(self, name):
        return self._convs[name].get("status", {})


def _cr(name, host=None, phase="Pending", gen=0, parent=None, sandbox_ref=None, host_ip=None):
    st = {"phase": phase, "generation": gen}
    if host is not None:
        st["hostPod"] = host
    if host_ip is not None:
        st["hostIP"] = host_ip
    spec = {}
    if parent is not None:
        spec["parentId"] = parent
    if sandbox_ref is not None:
        spec["sandboxRef"] = sandbox_ref
    return {"metadata": {"name": name}, "spec": spec, "status": st}


# --- the orphan reaper loop -------------------------------------------------

def test_reap_deletes_unreferenced_sandbox_past_grace():
    convs = [_cr("c1", sandbox_ref="conv-a")]
    sbs = [SandboxRef("conv-a", age_seconds=1000), SandboxRef("conv-orphan", age_seconds=1000)]
    k = FakeK8s([], convs, sandboxes=sbs)
    reaped = reap_orphans(k, grace_seconds=600)
    assert reaped == ["conv-orphan"]
    assert k.deleted_trees == ["conv-orphan"]


def test_reap_spares_young_orphan():
    k = FakeK8s([], [], sandboxes=[SandboxRef("conv-new", age_seconds=10)])
    assert reap_orphans(k, grace_seconds=600) == []
    assert k.deleted_trees == []


def test_reap_spares_referenced_sandbox():
    convs = [_cr("c1", sandbox_ref="conv-a")]
    k = FakeK8s([], convs, sandboxes=[SandboxRef("conv-a", age_seconds=99999)])
    assert reap_orphans(k, grace_seconds=600) == []


def test_reap_one_failure_does_not_abort_the_pass():
    class Boom(FakeK8s):
        def delete_sandbox_tree(self, name):
            if name == "conv-bad":
                raise RuntimeError("boom")
            super().delete_sandbox_tree(name)

    sbs = [SandboxRef("conv-bad", age_seconds=1000), SandboxRef("conv-good", age_seconds=1000)]
    k = Boom([], [], sandboxes=sbs)
    reaped = reap_orphans(k, grace_seconds=600)
    # conv-bad raised; conv-good still reaped.
    assert "conv-good" in k.deleted_trees
    assert reaped == ["conv-good"]


def test_pending_conversation_gets_a_host():
    k = FakeK8s([Pod("a", True)], [_cr("c1")])
    reconcile_once(k, cap=10)
    assert k.status("c1")["hostPod"] == "a"
    assert k.status("c1")["phase"] == "Assigned"
    assert k.status("c1")["generation"] == 1


def test_statusless_cr_unassignable_materializes_pending():
    # An unassignable CR with status: null must still get {phase: Pending} materialized.
    cr = {"metadata": {"name": "cnew"}, "spec": {}, "status": None}
    k = FakeK8s([], [cr])
    reconcile_once(k, cap=1)
    assert k.status("cnew").get("phase") == "Pending", "status:null CR must get phase materialized"


def test_already_pending_no_host_is_not_rechurned():
    cr = _cr("cp", phase="Pending")
    k = FakeK8s([], [cr])
    reconcile_once(k, cap=1)
    assert k.patches == [], "an already-materialized Pending must not be re-patched"


def test_notify_revive_returns_immediately_even_if_the_http_hangs():
    # The real notify_revive must return promptly even against an IP that black-holes the connect.
    import time
    from conversation_controller.k8s import ControllerK8s

    k = ControllerK8s(namespace="x")
    t = time.time()
    k.notify_revive("192.0.2.1", "c1", 1)  # RFC5737 TEST-NET-1, unroutable
    elapsed = time.time() - t
    assert elapsed < 1.0, f"notify_revive blocked {elapsed:.1f}s (must be fire-and-forget)"


def test_assign_patches_host_ip_and_pushes_revive():
    k = FakeK8s([Pod("a", True, ip="10.42.0.7")], [_cr("c1")])
    reconcile_once(k, cap=10)
    assert k.status("c1")["hostIP"] == "10.42.0.7"
    assert k.revives == [("10.42.0.7", "c1", 1)]


def test_no_revive_push_when_pod_has_no_ip_yet():
    # A pod with no IP yet is assigned but not pushed until the next tick.
    k = FakeK8s([Pod("a", True, ip=None)], [_cr("c1")])
    reconcile_once(k, cap=10)
    assert k.status("c1")["hostPod"] == "a"
    assert k.revives == []


def test_assigned_to_ready_host_is_noop():
    k = FakeK8s([Pod("a", True)], [_cr("c1", host="a", phase="Assigned", gen=1)])
    reconcile_once(k, cap=10)
    assert k.patches == []


def test_host_gone_triggers_reassign_with_gen_bump():
    k = FakeK8s([Pod("b", True)], [_cr("c1", host="a", phase="Assigned", gen=1)])
    reconcile_once(k, cap=10)
    assert k.status("c1")["hostPod"] == "b"
    assert k.status("c1")["generation"] == 2


def test_suspended_conversation_is_detached_end_to_end():
    # A suspended conversation with stale placement gets both hostPod and hostIP released
    # while its phase stays Suspended.
    k = FakeK8s([Pod("a", True)], [_cr("c1", host="a", phase="Suspended", gen=1, host_ip="10.1.4.35")])
    reconcile_once(k, cap=10)
    assert k.status("c1")["hostPod"] is None
    assert k.status("c1")["hostIP"] is None
    assert k.status("c1").get("phase") == "Suspended"


def test_suspended_stale_hostip_without_hostpod_is_repaired():
    # A lingering hostIP with no hostPod is repaired, not left as a NoOp.
    k = FakeK8s([Pod("a", True)], [_cr("c1", phase="Suspended", gen=2, host_ip="10.1.4.35")])
    reconcile_once(k, cap=10)
    assert k.status("c1")["hostIP"] is None
    assert k.status("c1")["hostPod"] is None
    assert k.status("c1").get("phase") == "Suspended"


def test_suspended_conversation_already_hostless_is_noop():
    cr = _cr("c1", phase="Suspended")
    k = FakeK8s([Pod("a", True)], [cr])
    reconcile_once(k, cap=10)
    assert k.patches == []


def test_two_pending_convs_balance_across_two_pods():
    k = FakeK8s([Pod("a", True), Pod("b", True)], [_cr("c1"), _cr("c2")])
    reconcile_once(k, cap=10)
    hosts = {k.status("c1")["hostPod"], k.status("c2")["hostPod"]}
    assert hosts == {"a", "b"}


def test_respects_cap_leaves_pending():
    k = FakeK8s([Pod("a", True)], [_cr("c1", host="a", phase="Assigned", gen=1), _cr("c2")])
    reconcile_once(k, cap=1)
    assert "hostPod" not in k.status("c2") or k.status("c2").get("hostPod") is None
    assert k.status("c2")["phase"] == "Pending"


def test_no_ready_pods_leaves_all_pending():
    k = FakeK8s([Pod("a", False)], [_cr("c1")])
    reconcile_once(k, cap=10)
    assert k.status("c1").get("hostPod") is None


def test_subagent_colocates_with_parent_in_one_pass():
    # The parent is assigned first and the child follows onto the same pod in the same pass,
    # bypassing the cap.
    k = FakeK8s([Pod("a", True), Pod("b", True)], [_cr("p1"), _cr("kid", parent="p1")])
    reconcile_once(k, cap=1)
    assert k.status("kid")["hostPod"] == k.status("p1")["hostPod"]


def test_subagent_stays_pending_until_parent_ready():
    k = FakeK8s([Pod("a", False)], [_cr("p1", host="a", phase="Assigned", gen=1), _cr("kid", parent="p1")])
    reconcile_once(k, cap=10)
    assert k.status("kid").get("hostPod") is None
    assert k.status("kid")["phase"] == "Pending"


# --- the agent-host autoscaler loop ----------------------------------------

class _Cfg:
    """Minimal config with only the fields autoscale_once reads."""
    def __init__(self, pod_cap=1, min_replicas=2, max_replicas=10, cooldown=300.0):
        self.pod_cap = pod_cap
        self.min_replicas = min_replicas
        self.max_replicas = max_replicas
        self.scale_down_cooldown_seconds = cooldown


def _cr_a(name, parent=None):
    return _cr(name, host="a", phase="Assigned", gen=1, parent=parent)


def test_autoscale_scales_up_immediately():
    convs = [_cr_a(f"c{i}") for i in range(4)]
    k = FakeK8s([Pod("a", True), Pod("b", True)], convs, replicas=2)
    st = AutoscaleState()
    m = autoscale_once(k, _Cfg(pod_cap=1, max_replicas=10), st, now=1000.0)
    assert k.scale_calls == [4]
    assert m["demand"] == 4 and m["target"] == 4


def test_autoscale_subagents_do_not_count():
    convs = [_cr_a("p1"), _cr_a("kid", parent="p1")]
    k = FakeK8s([Pod("a", True)], convs, replicas=2)
    m = autoscale_once(k, _Cfg(pod_cap=1), AutoscaleState(), now=1.0)
    assert m["demand"] == 1


def test_autoscale_scale_down_waits_for_cooldown():
    # The first scale-down lands; a second one 100s later is held by the cooldown.
    k = FakeK8s([Pod("a", True)], [], replicas=5)
    st = AutoscaleState()
    autoscale_once(k, _Cfg(pod_cap=1, cooldown=300.0), st, now=1000.0)
    assert k.scale_calls == [2]
    k._replicas = 4
    autoscale_once(k, _Cfg(pod_cap=1, cooldown=300.0), st, now=1100.0)
    assert k.scale_calls == [2]


def test_autoscale_noop_when_target_equals_current():
    convs = [_cr_a("c1"), _cr_a("c2")]
    k = FakeK8s([Pod("a", True), Pod("b", True)], convs, replicas=2)
    autoscale_once(k, _Cfg(pod_cap=1), AutoscaleState(), now=1.0)
    assert k.scale_calls == []


def test_autoscale_per_pod_metric():
    convs = [_cr_a(f"c{i}") for i in range(6)]
    k = FakeK8s([Pod("a", True), Pod("b", True)], convs, replicas=2)
    m = autoscale_once(k, _Cfg(pod_cap=5), AutoscaleState(), now=1.0)
    assert m["per_pod"] == 3.0


# --- phase-drift repair through the shell (MarkSuspended end-to-end) --------

def test_drifted_conversation_is_repaired_and_leaves_demand():
    from conversation_controller.reconcile import SandboxRef

    k8s = FakeK8s(
        pods=[Pod("a", True, ip="10.0.0.1")],
        convs=[_cr("drifted", host="a", phase="Assigned", gen=3, sandbox_ref="conv-x")],
        sandboxes=[SandboxRef(name="conv-x", age_seconds=1000.0, operating_mode="Suspended")],
    )
    results = reconcile_once(k8s, cap=10)

    assert ("drifted", "mark-suspended") in results
    # One patch fixes the phase and releases placement.
    assert ("drifted", {"phase": "Suspended", "hostPod": None, "hostIP": None}) in k8s.patches
    st = k8s._convs["drifted"]["status"]
    assert st["phase"] == "Suspended"
    assert st["hostPod"] is None


def test_running_sandbox_is_not_repaired():
    from conversation_controller.reconcile import SandboxRef

    k8s = FakeK8s(
        pods=[Pod("a", True, ip="10.0.0.1")],
        convs=[_cr("live", host="a", phase="Assigned", gen=1, sandbox_ref="conv-y")],
        sandboxes=[SandboxRef(name="conv-y", age_seconds=1000.0, operating_mode="Running")],
    )
    results = reconcile_once(k8s, cap=10)
    assert ("live", "noop") in results
    assert not any(p[1].get("phase") == "Suspended" for p in k8s.patches)


def test_sandbox_list_failure_must_not_abort_assignment():
    # Without a Sandbox CRD, listing throws; assignment must proceed with no drift repair.
    class ExplodingSandboxes(FakeK8s):
        def list_sandboxes(self):
            raise RuntimeError("the server could not find the requested resource (CRD absent)")

    k8s = ExplodingSandboxes(
        pods=[Pod("a", True, ip="10.0.0.1")],
        convs=[_cr("newborn")],
    )
    results = reconcile_once(k8s, cap=10)
    assert ("newborn", "assign") in results
    assert not any(kind == "mark-suspended" for _, kind in results)


# --- scale-down victim steering (pod-deletion-cost) ---------------------------


def _conv(name, host, phase="Assigned", parent=None):
    return {
        "metadata": {"name": name},
        "spec": ({"parentId": parent} if parent else {}),
        "status": {"phase": phase, "hostPod": host, "generation": 1},
    }


def test_hosting_pods_get_their_conversation_count_as_deletion_cost():  # @proves
    pods = [Pod("a", True, "10.0.0.1"), Pod("b", True, "10.0.0.2")]
    k8s = FakeK8s(pods, [_conv("c1", "a"), _conv("c2", "a"), _conv("c3", "b")])
    autoscale_once(k8s, _Cfg(), AutoscaleState(), now=0.0)
    assert ("a", 2) in k8s.cost_calls
    assert ("b", 1) in k8s.cost_calls


def test_empty_pods_cost_zero_and_unchanged_costs_are_not_repatched():  # @proves
    pods = [Pod("a", True, "10.0.0.1", deletion_cost=1), Pod("b", True, "10.0.0.2")]
    k8s = FakeK8s(pods, [_conv("c1", "a")])
    autoscale_once(k8s, _Cfg(), AutoscaleState(), now=0.0)
    assert ("a", 1) not in k8s.cost_calls, "unchanged cost must not be re-patched"
    assert ("b", 0) in k8s.cost_calls


def test_suspended_and_subagent_conversations_do_not_count():  # @proves
    pods = [Pod("a", True, "10.0.0.1")]
    k8s = FakeK8s(pods, [
        _conv("c1", "a", phase="Suspended"),
        _conv("c2", "a", parent="c-parent"),
        _conv("c3", "a"),
    ])
    autoscale_once(k8s, _Cfg(), AutoscaleState(), now=0.0)
    assert ("a", 1) in k8s.cost_calls


def test_terminating_pods_are_not_assignment_targets():  # @proves
    # A scale-down victim stays Ready through its grace period but must not receive work.
    pods = [Pod("dying", True, "10.0.0.1", terminating=True), Pod("alive", True, "10.0.0.2")]
    k8s = FakeK8s(pods, [_conv("c1", None, phase="Pending")])
    reconcile_once(k8s, cap=10)
    assigned = [st for name, st in k8s.patches if name == "c1"]
    assert assigned, "the conversation must be assigned"
    assert all(st.get("hostPod") != "dying" for st in assigned), "never to a terminating pod"


# --- zombie sandbox: backoff + terminal resolution ------------------------------------
#
# A zombie is phase=Suspended with placement released and the Sandbox still Running. The loop
# confirms it over two ticks, backs off between suspends, and after a bounded number of
# attempts reclaims the pod and marks the conversation Failed, logged once.


def _zombie():
    """A conversation the reconcile core flags as a zombie every tick."""
    convs = [_cr("z1", phase="Suspended", gen=2, sandbox_ref="conv-z1")]
    sbs = [SandboxRef("conv-z1", age_seconds=1000, operating_mode="Running")]
    return FakeK8s([Pod("a", True)], convs, sandboxes=sbs)


def test_zombie_two_tick_confirmation_no_suspend_on_single_sighting():
    # A single sighting can be a revive mid-flight, so it only marks a suspect.
    k = _zombie()
    res = dict(reconcile_once(k, cap=10))
    assert res["z1"] == "suspend-sandbox-suspect"
    assert k.suspends == []


def test_zombie_suspect_resets_when_conversation_revives():
    k = _zombie()
    reconcile_once(k, cap=10)  # t1: suspect
    assert k.suspends == []
    k._convs["z1"]["status"].update({"phase": "Assigned", "hostPod": "a"})
    reconcile_once(k, cap=10)  # t2: no longer a zombie
    assert k.suspends == []
    assert "z1" not in loop_mod._zombie_progress


def test_confirmed_zombie_is_not_resuspended_every_tick():
    k = _zombie()
    reconcile_once(k, cap=10)  # t1: suspect
    reconcile_once(k, cap=10)  # t2: first suspend
    assert k.suspends == ["conv-z1"]
    reconcile_once(k, cap=10)  # t3: backoff hold
    reconcile_once(k, cap=10)  # t4: backoff hold
    assert k.suspends == ["conv-z1"], "confirmed zombie must back off, not re-suspend every tick"


def test_persistent_zombie_is_acted_on_a_bounded_number_of_times_then_terminal():
    k = _zombie()
    for _ in range(50):
        reconcile_once(k, cap=10)
    assert 1 <= len(k.suspends) <= 5, f"expected a small bounded number of suspends, got {len(k.suspends)}"
    # The escalation reclaims the pod and leaves the Sandbox CR (and its workspace PVC) in place.
    assert k.reclaimed == ["conv-z1"]
    assert "conv-z1" in k._sandboxes, "the workspace PVC must survive the escalation (#709)"
    assert k.status("z1")["phase"] == "Failed"
    # The terminal state is idempotent.
    at_terminal = len(k.suspends)
    for _ in range(10):
        reconcile_once(k, cap=10)
    assert len(k.suspends) == at_terminal
    assert k.reclaimed == ["conv-z1"]


def test_failed_conversation_is_never_reassigned():
    k = FakeK8s([Pod("a", True)], [_cr("z1", phase="Failed", gen=9)])
    res = dict(reconcile_once(k, cap=10))
    assert res["z1"] == "noop"
    assert k.status("z1").get("hostPod") is None
    assert k.status("z1")["phase"] == "Failed"


def test_zombie_resolution_is_logged_once(caplog):
    import logging
    k = _zombie()
    with caplog.at_level(logging.WARNING, logger="conversation_controller.loop"):
        for _ in range(50):
            reconcile_once(k, cap=10)
    escalations = [r for r in caplog.records if "escalat" in r.getMessage().lower()]
    assert len(escalations) == 1, f"escalation must be logged once, saw {len(escalations)}"




# --- phase-drift repair: log de-dupe -----------------------------------------

def _drifting_k8s(names=("drifted",)):
    """Conversations whose drift never clears, as when a live owner races the controller."""
    from conversation_controller.reconcile import SandboxRef

    return FakeK8s(
        pods=[Pod("a", True, ip="10.0.0.1")],
        convs=[_cr(n, host="a", phase="Assigned", gen=3, sandbox_ref=f"sb-{n}") for n in names],
        sandboxes=[SandboxRef(name=f"sb-{n}", age_seconds=1000.0, operating_mode="Suspended") for n in names],
    )


def _rearm(k8s, name="drifted"):
    k8s._convs[name]["status"].update({"phase": "Assigned", "hostPod": "a", "hostIP": "10.0.0.1"})


def _drift(caplog, level):
    return [r for r in caplog.records if r.message == "phase drift repaired" and r.levelname == level]


def test_THE_SPAM_a_persistent_drift_warns_once_but_is_still_REPAIRED_every_pass(caplog):
    caplog.set_level("DEBUG")
    k8s = _drifting_k8s()
    for _ in range(5):
        reconcile_once(k8s, cap=10)
        _rearm(k8s)

    assert len(_drift(caplog, "WARNING")) == 1
    # Quieting the log must not quiet the fix.
    assert len([p for p in k8s.patches if p[1].get("phase") == "Suspended"]) == 5


def test_a_drift_that_CLEARS_and_returns_is_loud_again(caplog):
    caplog.set_level("DEBUG")
    k8s = _drifting_k8s()
    reconcile_once(k8s, cap=10)          # drifted -> warn
    reconcile_once(k8s, cap=10)          # clean pass -> forgotten
    _rearm(k8s)
    reconcile_once(k8s, cap=10)          # drifts again -> loud
    assert len(_drift(caplog, "WARNING")) == 2


# --- the escalation budget must survive the oscillation it is counting ------------------
#
# Unlike _zombie(), whose suspend never takes, these model a suspend that lands for a tick or
# two before an upstream resume race flips the Sandbox back to Running.


class OscillatingK8s(FakeK8s):
    """A zombie whose suspend lands and is then undone after `resume_after` ticks by the upstream resume race."""

    def __init__(self, *args, resume_after=2, **kwargs):
        super().__init__(*args, **kwargs)
        self._resume_after = resume_after
        self._pending_resume = 0

    def suspend_sandbox(self, name):
        super().suspend_sandbox(name)
        self._sandboxes[name] = SandboxRef(name, age_seconds=1000, operating_mode="Suspended")
        self._pending_resume = self._resume_after

    def list_sandboxes(self):
        if self._pending_resume:
            self._pending_resume -= 1
            if not self._pending_resume:
                for n in list(self._sandboxes):
                    self._sandboxes[n] = SandboxRef(n, age_seconds=1000, operating_mode="Running")
        return super().list_sandboxes()


def _oscillating_zombie(**kwargs):
    return OscillatingK8s(
        [Pod("a", True)],
        [_cr("z1", phase="Suspended", gen=2, sandbox_ref="conv-z1")],
        sandboxes=[SandboxRef("conv-z1", age_seconds=1000, operating_mode="Running")],
        **kwargs,
    )


def test_oscillating_zombie_still_reaches_the_terminal_escalation():
    k = _oscillating_zombie()
    for _ in range(120):
        reconcile_once(k, cap=10)

    assert len(k.suspends) <= 5, (
        f"budget reset by the quiescent tick — {len(k.suspends)} suspends in 120 ticks"
    )
    assert k.reclaimed == ["conv-z1"], "escalation never fired despite a persistent zombie"
    assert k.status("z1")["phase"] == "Failed"


def test_quiescent_tick_keeps_the_budget_but_still_re_confirms():
    k = _oscillating_zombie()
    reconcile_once(k, cap=10)  # t1: suspect
    reconcile_once(k, cap=10)  # t2: confirmed -> first suspend
    assert len(k.suspends) == 1

    reconcile_once(k, cap=10)  # t3: quiescent, the sandbox reads Suspended
    prog = loop_mod._zombie_progress["z1"]
    assert prog.suspends == 1, "the escalation budget must survive a quiescent tick"
    assert prog.confirms == 0, "the false-positive confirmation must reset"


def test_a_settled_sandbox_is_eventually_forgotten():
    # A suspend that holds is dropped once quiescence has lasted _ZOMBIE_FORGET_TICKS.
    k = _oscillating_zombie(resume_after=0)
    for _ in range(2 + loop_mod._ZOMBIE_FORGET_TICKS + 1):
        reconcile_once(k, cap=10)

    assert len(k.suspends) == 1, "a sandbox that stays suspended needs exactly one suspend"
    assert k.reclaimed == [], "a suspend that held must NOT escalate"
    assert "z1" not in loop_mod._zombie_progress, "a settled sandbox must be forgotten"


def test_a_real_revive_drops_the_record_immediately():
    # A genuine revive drops the record at once rather than waiting out the forget window.
    k = _oscillating_zombie()
    reconcile_once(k, cap=10)  # t1: suspect
    assert "z1" in loop_mod._zombie_progress

    k._convs["z1"]["status"].update({"phase": "Assigned", "hostPod": "a"})
    reconcile_once(k, cap=10)

    assert "z1" not in loop_mod._zombie_progress
    assert k.suspends == []


# --- reap_overlays (overlay-store retention) ---------------------------------


def test_reap_overlays_deletes_only_expired_overlays():
    day = 86400.0
    sbs = [
        SandboxRef("conv-old", age_seconds=90 * day, operating_mode="Suspended", suspended_seconds=8 * day),
        SandboxRef("conv-new", age_seconds=90 * day, operating_mode="Suspended", suspended_seconds=1 * day),
    ]
    k = FakeK8s([], [], sandboxes=sbs)
    k.pvcs = {"scooter-rw-conv-old", "workspace-conv-old", "scooter-rw-conv-new"}
    assert reap_overlays(k, 7 * day) == ["scooter-rw-conv-old"]
    assert k.pvcs == {"workspace-conv-old", "scooter-rw-conv-new"}


def test_reap_overlays_one_failure_does_not_abort_the_pass():
    day = 86400.0
    sbs = [
        SandboxRef(n, age_seconds=90 * day, operating_mode="Suspended", suspended_seconds=30 * day)
        for n in ("conv-boom", "conv-ok")
    ]
    k = FakeK8s([], [], sandboxes=sbs)
    k.pvcs = {"scooter-rw-conv-boom", "scooter-rw-conv-ok"}
    assert reap_overlays(k, 7 * day) == ["scooter-rw-conv-ok"]
