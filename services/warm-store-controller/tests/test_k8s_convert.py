"""Converting list responses read as raw JSON, as the API server sends them."""

import json
from types import SimpleNamespace

from warm_store_controller.k8s import _items, to_pool_pv, to_pvc

PV = {
    "metadata": {
        "name": "pv1",
        "resourceVersion": "42",
        "labels": {"scooter.io/warm-store": "abc", "scooter.io/pool": "returned"},
        "annotations": {"scooter.io/last-sandbox": "conv-a", "scooter.io/shutdown": "clean"},
        "deletionTimestamp": "2026-10-28T00:00:00Z",
        "managedFields": [{"manager": "x"}],
    },
    "spec": {
        "storageClassName": "pool",
        "persistentVolumeReclaimPolicy": "Delete",
        "claimRef": {"name": "scooter-rw-conv-a", "uid": "u1"},
        "nodeAffinity": {"required": {"nodeSelectorTerms": [
            {"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": ["n2"]}]},
        ]}},
    },
    "status": {"phase": "Bound"},
}


def test_items_reads_the_raw_body():
    resp = SimpleNamespace(data=json.dumps({"kind": "PersistentVolumeList", "items": [PV]}).encode())
    assert _items(resp) == [PV]


def test_to_pool_pv():
    pv = to_pool_pv(PV)
    assert (pv.name, pv.image_tag, pv.pool, pv.phase) == ("pv1", "abc", "returned", "Bound")
    assert (pv.claim_ref, pv.claim_uid, pv.last_sandbox) == ("scooter-rw-conv-a", "u1", "conv-a")
    assert pv.shutdown_clean and pv.terminating
    assert (pv.reclaim_policy, pv.resource_version, pv.node) == ("Delete", "42", "n2")


def test_to_pool_pv_with_optional_fields_absent():
    pv = to_pool_pv({"metadata": {"name": "bare"}, "spec": {}})
    assert (pv.claim_ref, pv.pool, pv.phase, pv.reclaim_policy) == (None, None, "", "Retain")
    assert pv.node_selector_terms == [] and not pv.terminating


def test_to_pvc():
    pvc = to_pvc({
        "metadata": {"name": "c", "labels": {"a": "b"}, "creationTimestamp": "2026-10-28T00:00:00Z"},
        "spec": {"volumeName": "pv1", "storageClassName": "pool"},
        "status": {"phase": "Bound"},
    })
    assert (pvc.volume_name, pvc.storage_class, pvc.phase, pvc.labels) == ("pv1", "pool", "Bound", {"a": "b"})
    assert pvc.created_at == 1793145600.0 and not pvc.terminating
    assert to_pvc({"metadata": {"name": "p"}, "spec": {"volumeName": ""}}).volume_name is None
