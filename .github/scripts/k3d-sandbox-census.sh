#!/usr/bin/env bash
# Census of the conv-* sandbox pods: did any of them crash during this run?
# Runs on every e2e-full run, since a sandbox can crash, be retried by the
# kubelet, and the spec still pass. Emits a GitHub warning annotation when any
# sandbox restarted and always exits 0; shared by k3d-dump-state.sh and the
# always-on CI step.
set -uo pipefail

# The host-wide per-uid inotify budget every sandbox systemd competes for; printed
# on every run so a fleet that lost the sysctl is visible.
echo "===== INOTIFY BUDGET (host runner / k3d node) ====="
host_inst=$(cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null || echo '?')
echo "  host  max_user_instances=$host_inst max_user_watches=$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo '?')"
# The node's view is the one the sandboxes face, so read it rather than assume it.
node=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -m1 -- '-server-0$' || true)
if [ -n "${node:-}" ]; then
  echo "  node($node)  max_user_instances=$(docker exec "$node" cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null || echo '?') max_user_watches=$(docker exec "$node" cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo '?')"
fi
# Best-effort: /proc entries this uid cannot read are skipped, so it is a floor.
echo "  observed inotify instances in /proc: $(find /proc/[0-9]*/fd -lname 'anon_inode:inotify' 2>/dev/null | wc -l) (floor, unreadable pids skipped)"
case "$host_inst" in
  ''|*[!0-9]*) : ;;
  *) [ "$host_inst" -lt 1024 ] && echo "::warning title=inotify budget::fs.inotify.max_user_instances=$host_inst on this runner; sandbox systemd failed to start below this. Why: PR #712" || true ;;
esac

# Eviction is decided on the node's nodefs/imagefs, not the host's /, so read from
# inside the node before teardown deletes it.
echo "===== NODE DISK (what the kubelet evicts on) ====="
if [ -n "${node:-}" ]; then
  docker exec "$node" df -h / /var/lib/rancher/k3s/agent/containerd 2>/dev/null \
    | sed 's/^/  /' || echo "  (node df unreadable)"
else
  echo "  (no k3d node container; nothing to read)"
fi
echo "  host docker data-root: $(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo '?')"
df -h "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)" /var/lib/k3d-containerd 2>/dev/null \
  | sed 's/^/  /' || true

nix shell nixpkgs#kubectl nixpkgs#jq -c bash -c '
  echo "===== SANDBOX RESTART CENSUS (all conv pods) ====="
  pods=$(kubectl -n agent-sandbox get pods -o json 2>/dev/null) || pods=""
  if [ -z "$pods" ]; then
    echo "  (no cluster reachable)"
    exit 0
  fi
  # ready uses tostring rather than `// "?"`, since jq treats false as absent.
  echo "$pods" | jq -r ".items[] | select(.metadata.name | startswith(\"conv-\")) | \"  \(.metadata.name) ready=\(.status.containerStatuses[0].ready | tostring) restarts=\(.status.containerStatuses[0].restartCount // 0)\"" || true
  bad=$(echo "$pods" | jq -r "[.items[] | select(.metadata.name | startswith(\"conv-\")) | select((.status.containerStatuses[0].restartCount // 0) > 0)] | length" 2>/dev/null || echo 0)
  total=$(echo "$pods" | jq -r "[.items[] | select(.metadata.name | startswith(\"conv-\"))] | length" 2>/dev/null || echo 0)
  echo "  -> ${bad:-0} of ${total:-0} sandboxes restarted at least once"
  # A pod deleted before this ran leaves no entry above, so its events are the only
  # trace of its crash.
  # Scoped to conv-* crash reasons, since platform bring-up is loud; `Killing` is
  # kept for liveness-probe kills, but teardown uses the same reason, so the
  # "Stopping container" message is filtered out.
  ev=$(kubectl -n agent-sandbox get events --sort-by=.lastTimestamp -o json 2>/dev/null) || ev=""
  echo "===== SANDBOX CRASH EVENTS (these survive pod deletion) ====="
  if [ -n "$ev" ]; then
    echo "$ev" | jq -r ".items[] | select(.involvedObject.name | startswith(\"conv-\")) | select(.reason | test(\"BackOff|Failed|Unhealthy|Killing|OOM|Evicted\")) | select(.message | test(\"Stopping container\") | not) | \"  \(.lastTimestamp) \(.reason) \(.involvedObject.name) \(.message)\"" | tail -60 || true
    # Never silently drop data: say how much was filtered and where it lives.
    other=$(echo "$ev" | jq -r "[.items[] | select((.involvedObject.name | startswith(\"conv-\")) | not) | select(.reason | test(\"BackOff|Failed|Unhealthy|Killing|OOM|Evicted\"))] | length" 2>/dev/null || echo 0)
    echo "  (${other:-0} non-sandbox warning events suppressed here; the failure dump carries them)"
    # The census above only sees pods that still exist, so the events are the real
    # denominator.
    seen=$(echo "$ev" | jq -r "[.items[] | .involvedObject.name | select(startswith(\"conv-\"))] | unique | length" 2>/dev/null || echo 0)
    echo "  -> ${seen:-0} distinct sandboxes appear in events this run (${total:-0} still alive at census time)"
  else
    echo "  (no events readable)"
  fi
  if [ "${bad:-0}" -gt 0 ]; then
    echo "::warning title=sandbox crash loop::${bad} of ${total} conv-* sandboxes restarted during this run"
  fi
  true
'
exit 0
