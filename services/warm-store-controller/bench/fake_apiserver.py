"""A fake API server; its own process keeps its CPU unmeasured."""

from __future__ import annotations

import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NS = "agent-sandbox"
TAG = "bench-tag"
POOL_CLASS = "pool"
SANDBOX = "conv-bench"
NODES = ["n1", "n2", "n3"]
STAMP = "2026-10-01T00:00:00Z"


def _affinity(node: str) -> dict:
    term = {"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": [node]}]}
    return {"required": {"nodeSelectorTerms": [term]}}


def _meta(name: str, i: int, **extra) -> dict:
    # managedFields keeps the body size realistic.
    managed = [{
        "manager": "local-path-provisioner", "operation": "Update", "apiVersion": "v1", "time": STAMP,
        "fieldsType": "FieldsV1", "fieldsV1": {"f:metadata": {"f:annotations": {".": {}}}, "f:spec": {"f:nodeAffinity": {}}},
    }]
    return {
        "name": name, "uid": f"uid-{name}", "resourceVersion": str(1000 + i), "creationTimestamp": STAMP,
        "finalizers": ["kubernetes.io/pv-protection"], "managedFields": managed, **extra,
    }


def cluster(n: int) -> dict[str, list[dict]]:
    """Half pool PVs, half workspace PVs pinning sandboxes."""
    pvs, pvcs, sandboxes = [], [], []
    for i in range(n):
        node = NODES[i % len(NODES)]
        if i % 2:
            sb = f"conv-{i}"
            pvs.append({
                "metadata": _meta(f"pvc-ws-{i}", i, annotations={"pv.kubernetes.io/provisioned-by": "rancher.io/local-path"}),
                "spec": {
                    "storageClassName": "local-path", "persistentVolumeReclaimPolicy": "Delete",
                    "claimRef": {"name": f"workspace-{sb}", "namespace": NS, "uid": f"u{i}"},
                    "capacity": {"storage": "10Gi"}, "hostPath": {"path": f"/var/lib/local-path/ws-{i}"},
                    "nodeAffinity": _affinity(node),
                },
                "status": {"phase": "Bound"},
            })
            pvcs.append({
                "metadata": _meta(f"workspace-{sb}", i, namespace=NS),
                "spec": {"storageClassName": "local-path", "volumeName": f"pvc-ws-{i}"},
                "status": {"phase": "Bound"},
            })
            sandboxes.append({
                "metadata": {"name": sb, "namespace": NS, "creationTimestamp": STAMP},
                "spec": {"operatingMode": "Running", "podTemplate": {"spec": {"containers": [{"image": f"img:{TAG}"}]}}},
            })
            continue
        kind = ("warm", "returned", "bound")[(i // 2) % 3]
        labels = {"scooter.io/warm-store": TAG}
        ann = {"scooter.io/last-sandbox": f"conv-{i + 1}", "scooter.io/released-at": STAMP}
        claim = None
        if kind == "bound":
            claim = {"name": f"scooter-rw-conv-{i + 1}", "namespace": NS, "uid": f"r{i}"}
        else:
            labels["scooter.io/pool"] = kind
            ann["scooter.io/shutdown"] = "clean"
        pvs.append({
            "metadata": _meta(f"pvc-pool-{i}", i, labels=labels, annotations=ann),
            "spec": {
                "storageClassName": POOL_CLASS, "persistentVolumeReclaimPolicy": "Retain", "claimRef": claim,
                "capacity": {"storage": "20Gi"}, "hostPath": {"path": f"/var/lib/local-path/pool-{i}"},
                "nodeAffinity": _affinity(node),
            },
            "status": {"phase": "Bound" if claim else "Available"},
        })
    pvcs.append({
        "metadata": _meta(f"scooter-rw-{SANDBOX}", n, namespace=NS),
        "spec": {"storageClassName": POOL_CLASS},
        "status": {"phase": "Pending"},
    })
    nodes = [{"metadata": _meta(nd, 0, labels={"kubernetes.io/hostname": nd}), "spec": {}} for nd in NODES]
    return {"pvs": pvs, "pvcs": pvcs, "sandboxes": sandboxes, "nodes": nodes}


def _list(items: list[dict]) -> bytes:
    return json.dumps({"apiVersion": "v1", "kind": "List", "metadata": {"resourceVersion": "1"}, "items": items}).encode()


def serve(n: int) -> None:
    c = cluster(n)
    pvc_by_name = {p["metadata"]["name"]: p for p in c["pvcs"]}
    lists = {
        r"/api/v1/persistentvolumes": _list(c["pvs"]),
        rf"/api/v1/namespaces/{NS}/persistentvolumeclaims": _list(c["pvcs"]),
        r"/api/v1/nodes": _list(c["nodes"]),
        rf"/apis/[^/]+/[^/]+/namespaces/{NS}/sandboxes": _list(c["sandboxes"]),
    }
    empty = _list([])
    status = json.dumps({"kind": "Status", "apiVersion": "v1", "status": "Success", "metadata": {}}).encode()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        disable_nagle_algorithm = True

        def _send(self, code: int, body: bytes) -> None:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _drain(self) -> bytes:
            return self.rfile.read(int(self.headers.get("Content-Length") or 0))

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            for pat, body in lists.items():
                if re.fullmatch(pat, path):
                    return self._send(200, body)
            m = re.fullmatch(rf"/api/v1/namespaces/{NS}/persistentvolumeclaims/([^/]+)", path)
            if m and m.group(1) in pvc_by_name:
                return self._send(200, json.dumps(pvc_by_name[m.group(1)]).encode())
            if path.rsplit("/", 1)[-1] in ("pods", "jobs", "persistentvolumeclaims"):
                return self._send(200, empty)
            self._send(404, json.dumps({"kind": "Status", "status": "Failure", "code": 404, "reason": "NotFound"}).encode())

        def _echo(self) -> None:
            # Writes succeed and echo the body; every caller accepts that.
            body = self._drain() or b"{}"
            obj = json.loads(body)
            obj.setdefault("metadata", {}).setdefault("name", self.path.rsplit("/", 1)[-1].split("?")[0])
            self._send(200, json.dumps(obj).encode())

        do_PATCH = _echo
        do_POST = _echo
        do_PUT = _echo

        def do_DELETE(self) -> None:
            self._drain()
            self._send(200, status)

        def log_message(self, *_a) -> None:
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(srv.server_address[1], flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--pvs", type=int, required=True)
    serve(ap.parse_args().pvs)
