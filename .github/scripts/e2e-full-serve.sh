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

# Platform log follower: every agent-host / router / controller pod's log with
# timestamps, for the whole run. The failure dump only has each surviving pod's
# tail, which misses the failing window on a long run and loses pods a rollout
# spec replaced; stern follows pods as they come and go. One file per call, so
# the base's control run (which sources its own copy of this script) does not
# overwrite the PR's.
mkdir -p /tmp/platform-logs
PLATFORM_LOG=/tmp/platform-logs/$(date -u +%H%M%S)-platform.log
nix shell nixpkgs#stern -c stern -n agent-sandbox \
  --selector 'app in (agent-host,conversation-router,conversation-controller)' \
  --timestamps --color never >"$PLATFORM_LOG" 2>&1 &
LOGS_PID=$!

# The rollout/move hook lets the browser specs delete the owner pod or restart the
# deployment, with kubectl running here rather than in the browser.
nix shell nixpkgs#kubectl -c python3 test/e2e/support/rolloutHook.py 8898 >/tmp/rollout-hook.log 2>&1 &
HOOK_PID=$!

# Per-conversation service origins, when the deployed platform has them on: a
# port-forward of the router's sandbox listener, behind sandboxEdge.mjs playing the
# wildcard Ingress (TLS, Host intact). The domain is read off the deployment, so a
# platform without one (e.g. the base branch's control run) gets neither, and
# playwright.config.ts only maps `*.<domain>` when E2E_SANDBOX_DOMAIN is set.
SANDBOX_PIDS=()
E2E_SANDBOX_DOMAIN=$(nix shell nixpkgs#kubectl -c kubectl -n agent-sandbox get deployment/conversation-router \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="SANDBOX_DOMAIN")].value}' 2>/dev/null || true)
if [ -n "$E2E_SANDBOX_DOMAIN" ]; then
  nix shell nixpkgs#kubectl -c kubectl -n agent-sandbox port-forward svc/agent-host 8896:8081 >/tmp/pf-sandbox.log 2>&1 &
  SANDBOX_PIDS+=($!)
  mkdir -p /tmp/sandbox-edge
  nix shell nixpkgs#openssl -c openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
    -keyout /tmp/sandbox-edge/key.pem -out /tmp/sandbox-edge/cert.pem \
    -subj "/CN=*.${E2E_SANDBOX_DOMAIN}" >/dev/null 2>&1
  nix shell nixpkgs#nodejs_22 -c node test/e2e/support/sandboxEdge.mjs 8897 127.0.0.1:8896 \
    /tmp/sandbox-edge/cert.pem /tmp/sandbox-edge/key.pem >/tmp/sandbox-edge.log 2>&1 &
  SANDBOX_PIDS+=($!)
  export E2E_SANDBOX_DOMAIN
  export E2E_SANDBOX_EDGE=127.0.0.1:8897
fi

trap 'kill "$PF_PID" "$SAMPLER_PID" "$LOGS_PID" "$HOOK_PID" ${SANDBOX_PIDS[@]+"${SANDBOX_PIDS[@]}"} 2>/dev/null || true' EXIT

# Wait on a real GET, not the port bind — the forward accepts before nginx serves.
for _ in $(seq 1 60); do
  curl -sf -o /dev/null http://127.0.0.1:8899/ && break
  sleep 2
done
curl -sf -o /dev/null http://127.0.0.1:8899/ || { echo "the UI never served:"; cat /tmp/pf.log; exit 1; }

# The sandbox listener 404s a host with no conversation, so any answer means the
# forward, the edge and the router are all up.
if [ -n "${E2E_SANDBOX_DOMAIN:-}" ]; then
  for _ in $(seq 1 30); do
    code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "ffffffff.${E2E_SANDBOX_DOMAIN}:8897:127.0.0.1" \
      "https://ffffffff.${E2E_SANDBOX_DOMAIN}:8897/x/" || true)
    [ "$code" = "404" ] && break
    sleep 2
  done
  [ "$code" = "404" ] || { echo "the sandbox edge never served (last: $code):"; cat /tmp/pf-sandbox.log /tmp/sandbox-edge.log; exit 1; }
fi
