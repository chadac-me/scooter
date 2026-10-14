#!/usr/bin/env bash
# Expose the deployed platform to a Playwright full run and start the
# out-of-browser helpers those specs need. Source this
# (`. .github/scripts/e2e-full-serve.sh`) rather than execute it, so the
# background PIDs and the cleanup `trap` live in the step's shell and are reaped
# when the step ends. Returns only once the UI answers a GET; callers are expected
# to have `set -euo pipefail`.

# Port-forward the `ui` Service (nginx: static build + API proxy), so one origin
# serves the app and the API as in the browser's real topology.
nix shell nixpkgs#kubectl -c kubectl -n agent-sandbox rollout status deployment/ui --timeout=180s
nix shell nixpkgs#kubectl -c kubectl -n agent-sandbox port-forward svc/ui 8899:8080 >/tmp/pf.log 2>&1 &
PF_PID=$!

# Cluster sampler: every 15s, the node's Allocated-resources table and the pod
# list, so a sandbox Pending on Insufficient cpu leaves a trace.
( while true; do
    echo "== $(date -u +%H:%M:%S)"
    nix shell nixpkgs#kubectl -c bash -c '
      kubectl get pods -n agent-sandbox -o wide 2>/dev/null | grep -v Completed
      kubectl describe nodes 2>/dev/null | grep -A8 "Allocated resources"'
    sleep 15
  done >/tmp/cluster-sampler.log 2>&1 ) &
SAMPLER_PID=$!

# The rollout/move hook lets the browser specs delete the owner pod or restart the
# deployment, with kubectl running here rather than in the browser.
nix shell nixpkgs#kubectl -c python3 test/e2e/support/rolloutHook.py 8898 >/tmp/rollout-hook.log 2>&1 &
HOOK_PID=$!

trap 'kill "$PF_PID" "$SAMPLER_PID" "$HOOK_PID" 2>/dev/null || true' EXIT

# Wait on a real GET, not the port bind — the forward accepts before nginx serves.
for _ in $(seq 1 60); do
  curl -sf -o /dev/null http://127.0.0.1:8899/ && break
  sleep 2
done
curl -sf -o /dev/null http://127.0.0.1:8899/ || { echo "the UI never served:"; cat /tmp/pf.log; exit 1; }
