"""Tier 1: the reconcile loop against a fake k8s with in-memory PVCs and Sandboxes, no cluster."""

from warm_store_controller.loop import reconcile_once
from warm_store_controller.reservations import Reservations
from warm_store_controller.reconcile import PoolPvc, SandboxRef, PoolConfig

TAG = "abc123def456"
OLD = "000oldtag0000"


class FakeK8s:
    """In-memory pool PVCs and Sandboxes, recording every applied action and mutating the PVC set so a follow-up pass sees it."""

    def __init__(self, pvcs, sandboxes):
        self._pvcs = {p.name: p for p in pvcs}
        self._sandboxes = list(sandboxes)
        self.warmed = []      # [image_tag]
        self.relabels = []    # [(pvc, state, labels)]
        self.deletes = []     # [pvc]
        self._warm_seq = 0

    def list_pool_pvcs(self):
        return list(self._pvcs.values())

    # An empty PV pool makes the placement phase a no-op.
    def list_pending_uppers(self):
        return []

    def iter_pool_pvs(self):
        return iter(())

    def adopt_bound_pvs(self, pvcs):
        self.adopted = getattr(self, 'adopted', []) + list(pvcs)

    def list_nodes(self):
        return []

    def list_sandboxes(self):
        return list(self._sandboxes)

    def warm_new(self, image_tag):
        self.warmed.append(image_tag)
        self._warm_seq += 1
        name = f"warm-{image_tag}-{self._warm_seq}"
        self._pvcs[name] = PoolPvc(name=name, image_tag=image_tag, state="warming")

    def relabel(self, pvc, state, labels):
        self.relabels.append((pvc, state, labels))
        cur = self._pvcs[pvc]
        self._pvcs[pvc] = PoolPvc(
            name=cur.name,
            image_tag=cur.image_tag,
            state=state,
            claimed_by=(None if labels.get("scooter.io/claimed-by", "keep") is None else cur.claimed_by),
            last_used=cur.last_used,
            bound_to_pod=cur.bound_to_pod,
        )

    def delete_pvc(self, pvc):
        self.deletes.append(pvc)
        self._pvcs.pop(pvc, None)


def cfg(min_ready=1, max_total=8):
    return PoolConfig(current_image_tag=TAG, min_ready=min_ready, max_total=max_total)


def test_loop_warms_when_pool_empty():
    k = FakeK8s([], [])
    reconcile_once(k, cfg(min_ready=2), Reservations(), {})
    assert k.warmed == [TAG, TAG]


def test_loop_returns_suspended_clean_pvc():
    k = FakeK8s(
        [PoolPvc("p1", TAG, "claimed", claimed_by="conv-a", bound_to_pod=False)],
        [SandboxRef("conv-a", TAG, suspended=True, unmount_marker="clean")],
    )
    reconcile_once(k, cfg(min_ready=1), Reservations(), {})
    assert ("p1", "ready", {"scooter.io/claimed-by": None}) in k.relabels


def test_loop_discards_unclean_return():
    k = FakeK8s(
        [PoolPvc("p1", TAG, "claimed", claimed_by="conv-a", bound_to_pod=False)],
        [SandboxRef("conv-a", TAG, suspended=True, unmount_marker="unclean")],
    )
    reconcile_once(k, cfg(min_ready=0), Reservations(), {})
    assert "p1" in k.deletes


def test_loop_does_not_redelete_terminating_pvc():
    # A claimed PVC that is already Terminating is not deleted again, even with an `unclean` sandbox.
    k = FakeK8s(
        [PoolPvc("p1", TAG, "claimed", claimed_by="conv-a", bound_to_pod=False, terminating=True)],
        [SandboxRef("conv-a", TAG, suspended=True, unmount_marker="unclean")],
    )
    reconcile_once(k, cfg(min_ready=0), Reservations(), {})
    assert "p1" not in k.deletes


def test_loop_unknown_marker_does_not_delete():
    # An inconclusive marker read backs off with no delete.
    k = FakeK8s(
        [PoolPvc("p1", TAG, "claimed", claimed_by="conv-a", bound_to_pod=False)],
        [SandboxRef("conv-a", TAG, suspended=True, unmount_marker="unknown")],
    )
    reconcile_once(k, cfg(min_ready=0), Reservations(), {})
    assert k.deletes == []


def test_loop_gcs_retired_tag():
    k = FakeK8s([PoolPvc("r-old", OLD, "ready")], [])
    reconcile_once(k, cfg(min_ready=0), Reservations(), {})
    assert "r-old" in k.deletes


def test_loop_one_bad_action_does_not_abort_pass():
    # A delete that raises must not stop a subsequent warm from applying.
    class Boom(FakeK8s):
        def delete_pvc(self, pvc):
            raise RuntimeError("boom")

    k = Boom([PoolPvc("r-old", OLD, "ready")], [])
    reconcile_once(k, cfg(min_ready=1), Reservations(), {})
    assert k.warmed == [TAG]
