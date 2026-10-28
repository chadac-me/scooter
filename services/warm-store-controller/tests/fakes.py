"""An in-memory ControllerK8s: real conversions over hand-built PV dicts."""

from __future__ import annotations

from kubernetes.client.exceptions import ApiException

from warm_store_controller import janitor as j
from warm_store_controller.allocate import Node, PoolPv
from warm_store_controller.k8s import ControllerK8s


def raw_pv(
    name: str,
    *,
    phase: str = "Available",
    sc: str = "pool",
    node: str = "n1",
    claim: str | None = None,
    uid: str | None = None,
    labels: dict | None = None,
    annotations: dict | None = None,
    rv: str = "1",
):
    return {
        "metadata": {"name": name, "labels": labels or {}, "annotations": annotations or {}, "resourceVersion": rv},
        "spec": {
            "storageClassName": sc,
            "claimRef": {"name": claim, "uid": uid} if claim else None,
            "persistentVolumeReclaimPolicy": "Retain",
            "nodeAffinity": {"required": {"nodeSelectorTerms": [
                {"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": [node]}]},
            ]}},
        },
        "status": {"phase": phase},
    }


class FakeK8s(ControllerK8s):
    def __init__(self, pvs=(), pvcs=(), sandboxes=(), nodes=("n1", "n2")) -> None:
        super().__init__(namespace="ns", pool_storage_class="pool")
        self.pvs = list(pvs)
        self.pvcs = {p.name: p for p in pvcs}
        self.sandboxes = {s.name: s for s in sandboxes}
        self.nodes = [Node(n, {"kubernetes.io/hostname": n}) for n in nodes]
        self.calls: list[tuple] = []
        self.conflicts: set[str] = set()

    def list_pvs(self):
        return list(self.pvs)

    def read_pvc(self, name):
        return self.pvcs.get(name)

    def read_sandbox(self, name):
        return self.sandboxes.get(name)

    def list_nodes(self):
        return self.nodes

    def set_pvc_label(self, name, key, value):
        self.calls.append(("label-pvc", name, key, value))
        p = self.pvcs.get(name)
        if p is not None:
            labels = {k: v for k, v in p.labels.items() if k != key}
            if value is not None:
                labels[key] = value
            self.pvcs[name] = j.Pvc(p.name, p.phase, p.volume_name, p.storage_class, labels, p.terminating, p.created_at)

    def delete_marker_jobs(self, pvc):
        self.calls.append(("delete-marker-jobs", pvc))

    def delete_warm_jobs(self, pvc):
        self.calls.append(("delete-warm-jobs", pvc))

    def reserve(self, pv: PoolPv, pvc_name: str):
        if pv.name in self.conflicts:
            raise ApiException(status=409)
        self.calls.append(("reserve", pv.name, pvc_name))

    def mark_clean(self, pv_name):
        self.calls.append(("mark-clean", pv_name))

    def retire_bound(self, pv_name):
        self.calls.append(("retire-bound", pv_name))

    def delete_pvc(self, name):
        self.calls.append(("delete-pvc", name))
        self.pvcs.pop(name, None)

    # --- the pass's reads and writes ---
    def list_pvcs(self):
        return dict(self.pvcs)

    def list_sandboxes(self):
        return dict(self.sandboxes)

    def mounted_claims(self):
        return set()

    def warm_jobs(self):
        return {}, []

    def marker_jobs(self):
        return {}

    def retire(self, pv):
        self.calls.append(("retire", pv.name))

    def label_bound(self, pv, tag, last_sandbox, drop_shutdown):
        self.calls.append(("label-pv", pv.name, tag, last_sandbox))

    def recycle(self, pv, pool):
        self.calls.append(("recycle", pv.name, pool))

    def clear_reservation(self, pv):
        self.calls.append(("clear-reservation", pv.name))

    def start_warm(self, tag, node):
        self.calls.append(("start-warm", tag, node))
        return "warm-store-x"

    def start_marker_check(self, pvc):
        self.calls.append(("marker-check", pvc))
