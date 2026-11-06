#!/usr/bin/env python3
"""Cluster-mutation hook for the e2e-full rollout/move stories.

The browser cannot run kubectl, so specs POST here to disturb the cluster mid-conversation:
POST /restart rollout-restarts the agent-host Deployment and waits, and POST /move/<thread>
deletes the pod hosting <thread>'s conversation so the controller reassigns it. The warm-store
stories read and disturb the overlay pool: GET /overlay/<thread>, GET /pool, POST and GET
/canary/<thread>, POST /warm-store/scale/<n>. Stdlib only, shells out to kubectl on PATH.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

NS = "agent-sandbox"

def sh(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=180)

# A file in the overlay volume's root, outside the overlay itself.
CANARY = "/nix/.scooter-rw/e2e-canary"
POOL_LABEL = "scooter.io/pool"
WSC_SELECTOR = "app=warm-store-controller"

def kget(*args: str) -> dict | None:
    r = sh("kubectl", "-n", NS, "get", *args, "-o", "json")
    return json.loads(r.stdout) if r.returncode == 0 else None

def pv_view(pv: dict) -> dict:
    meta = pv["metadata"]
    ref = pv["spec"].get("claimRef") or {}
    return {
        "name": meta["name"],
        "phase": pv.get("status", {}).get("phase"),
        "pool": meta.get("labels", {}).get(POOL_LABEL),
        "annotations": {k: v for k, v in meta.get("annotations", {}).items() if k.startswith("scooter.io/")},
        "claim": ref.get("name"),
        "storageClass": pv["spec"].get("storageClassName"),
    }

def thread_ok(thread: str) -> bool:
    return re.fullmatch(r"[A-Za-z0-9-]+", thread) is not None

def sandbox_of(thread: str) -> str:
    """The Sandbox name; mirrors shortId in services/agent-host/src/session/manager.ts."""
    h = 0
    for c in thread:
        h = (h * 31 + ord(c)) & 0xFFFFFFFF
    n = abs(h - (1 << 32) if h >= 1 << 31 else h)
    digits = ""
    while True:
        n, r = divmod(n, 36)
        digits = "0123456789abcdefghijklmnopqrstuvwxyz"[r] + digits
        if n == 0:
            return f"conv-{digits}"

class Hook(BaseHTTPRequestHandler):
    def _reply(self, code: int, body: str) -> None:
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler contract
        if self.path == "/restart":
            r = sh("kubectl", "-n", NS, "rollout", "restart", "deployment/agent-host")
            if r.returncode != 0:
                return self._reply(500, r.stderr)
            w = sh("kubectl", "-n", NS, "rollout", "status", "deployment/agent-host", "--timeout=180s")
            return self._reply(200 if w.returncode == 0 else 500, w.stdout + w.stderr)

        if self.path.startswith("/move/"):
            thread = self.path.removeprefix("/move/")
            # The owner is the conversations row's host_pod, read in the shared Postgres pod.
            if not re.fullmatch(r"[A-Za-z0-9-]+", thread):
                return self._reply(400, "bad conversation id")
            r = sh("kubectl", "-n", NS, "exec", "deploy/agent-shared-db", "-c", "postgres", "--",
                   "psql", "-U", "postgres", "-d", "agent_host", "-tAc",
                   f"SELECT coalesce(host_pod, '') FROM conversations WHERE id = '{thread}'")
            if r.returncode != 0:
                return self._reply(500, r.stderr)
            host = r.stdout.strip()
            if not host:
                return self._reply(409, "conversation has no row or no host_pod yet")
            d = sh("kubectl", "-n", NS, "delete", "pod", host, "--wait=false")
            return self._reply(200 if d.returncode == 0 else 500, f"deleted {host}\n" + d.stderr)

        if self.path.startswith("/canary/"):
            thread = self.path.removeprefix("/canary/")
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
            if not (thread_ok(thread) and thread_ok(body)):
                return self._reply(400, "bad conversation id or canary")
            r = sh("kubectl", "-n", NS, "exec", sandbox_of(thread), "-c", "sandbox", "--",
                   "sh", "-c", f"echo {body} > {CANARY} && sync")
            return self._reply(200 if r.returncode == 0 else 500, r.stdout + r.stderr)

        m = re.fullmatch(r"/warm-store/scale/([01])", self.path)
        if m:
            r = sh("kubectl", "-n", NS, "scale", "deployment/warm-store-controller", f"--replicas={m[1]}")
            if r.returncode != 0:
                return self._reply(500, r.stderr)
            # Scale-down waits for the pod to go, so /reserve is really unreachable afterwards.
            w = (sh("kubectl", "-n", NS, "rollout", "status", "deployment/warm-store-controller", "--timeout=180s")
                 if m[1] == "1" else
                 sh("kubectl", "-n", NS, "wait", "--for=delete", "pod", "-l", WSC_SELECTOR, "--timeout=120s"))
            return self._reply(200 if w.returncode == 0 else 500, w.stdout + w.stderr)

        return self._reply(404, "unknown hook")

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler contract
        if self.path == "/pool":
            pvs = (kget("pv") or {"items": []})["items"]
            idle = [pv_view(pv) for pv in pvs
                    if POOL_LABEL in pv["metadata"].get("labels", {}) and pv.get("status", {}).get("phase") == "Available"]
            return self._json(200, idle)

        if self.path.startswith("/overlay/"):
            # The PV the overlay PVC is bound to, else the PV that last served the sandbox.
            thread = self.path.removeprefix("/overlay/")
            if not thread_ok(thread):
                return self._reply(400, "bad conversation id")
            sandbox = sandbox_of(thread)
            pvc = kget("pvc", f"scooter-rw-{sandbox}")
            pvs = (kget("pv") or {"items": []})["items"]
            bound = pvc["spec"].get("volumeName") if pvc else None
            pv = next((p for p in pvs if p["metadata"]["name"] == bound), None) or next(
                (p for p in pvs if p["metadata"].get("annotations", {}).get("scooter.io/last-sandbox") == sandbox), None)
            return self._json(200, {
                "sandbox": sandbox,
                "pvc": None if pvc is None else {
                    "phase": pvc.get("status", {}).get("phase"),
                    "volume": bound,
                    "storageClass": pvc["spec"].get("storageClassName"),
                    "labels": pvc["metadata"].get("labels", {}),
                },
                "pv": None if pv is None else pv_view(pv),
            })

        if self.path.startswith("/canary/"):
            thread = self.path.removeprefix("/canary/")
            if not thread_ok(thread):
                return self._reply(400, "bad conversation id")
            r = sh("kubectl", "-n", NS, "exec", sandbox_of(thread), "-c", "sandbox", "--", "cat", CANARY)
            return self._reply(200 if r.returncode == 0 else 404, r.stdout.strip() or r.stderr)

        return self._reply(404, "unknown hook")

    def _json(self, code: int, body: object) -> None:
        self._reply(code, json.dumps(body))

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[rollout-hook] {fmt % args}", file=sys.stderr)

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8898
    print(f"[rollout-hook] listening on {port}", file=sys.stderr)
    HTTPServer(("127.0.0.1", port), Hook).serve_forever()
