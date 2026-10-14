#!/usr/bin/env bash
# Dump everything needed to diagnose a failed e2e full run; every command is
# `|| true` so one missing resource cannot hide the rest. Shared by `e2e full
# shard` and `flake focus full`.
# The crash census, shared with the always-on CI step.
"$(dirname "$0")/k3d-sandbox-census.sh" || true
nix shell nixpkgs#kubectl nixpkgs#jq nixpkgs#docker-client nixpkgs#systemd -c bash -c '
  kubectl -n agent-sandbox get pods,deploy,svc,pvc,conversations -o wide || true
  # describe shows the scheduling reason of a Pending pod and the Last State of a
  # crashed container, which a bare get hides.
  kubectl -n agent-sandbox describe deploy/agent-host || true
  for app in agent-host conversation-controller conversation-router; do
    kubectl -n agent-sandbox describe pods -l app="$app" || true
  done
  kubectl describe nodes || true
  kubectl -n agent-sandbox get sandboxes.agents.x-k8s.io -o wide || true
  kubectl -n agent-sandbox get events --sort-by=.lastTimestamp | tail -120 || true
  kubectl -n agent-sandbox logs -l app=agent-host --tail=300 || true
  kubectl -n agent-sandbox logs -l app=conversation-controller --tail=150 || true
  kubectl -n agent-sandbox logs -l app=conversation-router --tail=150 || true
  # Plain logs serves the current attempt, so the fatal output of a crash loop is
  # only in --previous, which `logs -l` does not support.
  for app in agent-host conversation-controller conversation-router; do
    for pod in $(kubectl -n agent-sandbox get pods -l app="$app" -o name 2>/dev/null); do
      restarts=$(kubectl -n agent-sandbox get "$pod" \
        -o jsonpath="{.status.containerStatuses[0].restartCount}" 2>/dev/null || echo 0)
      [ "${restarts:-0}" -gt 0 ] || continue
      echo "===== PREVIOUS container log: $pod (restarts=$restarts) ====="
      kubectl -n agent-sandbox logs "$pod" --previous --tail=200 || true
    done
  done
  # These Jobs create the agent-pg-* secrets every service mounts.
  for j in agent-postgres-init agent-db-migrate; do
    for job in $(kubectl -n agent-sandbox get job -l "app.kubernetes.io/name=$j" -o name 2>/dev/null); do
      echo "===== JOB LOG: $job (all containers) ====="
      # By job: a finished pod may be gone or unlabelled.
      timeout 20 kubectl -n agent-sandbox logs "$job" --all-containers --tail=200 2>&1 | tail -60 || true
      kubectl -n agent-sandbox describe "$job" 2>/dev/null | grep -iE "^(Pods|Completions|Failed)" || true
    done
  done
  echo "===== agent-pg-* secrets present ====="
  kubectl -n agent-sandbox get secrets 2>/dev/null | grep agent-pg || echo "(NONE — services cannot start)"

  # The conv-* sandbox pods carry none of the `app` labels above, and one sandbox
  # that never goes ready reads as many unrelated spec failures.
  for pod in $(kubectl -n agent-sandbox get pods -o name 2>/dev/null | grep "^pod/conv-"); do
    ready=$(kubectl -n agent-sandbox get "$pod" \
      -o jsonpath="{.status.containerStatuses[0].ready}" 2>/dev/null || echo unknown)
    restarts=$(kubectl -n agent-sandbox get "$pod" \
      -o jsonpath="{.status.containerStatuses[0].restartCount}" 2>/dev/null || echo 0)
    [ "$ready" = "true" ] && [ "${restarts:-0}" -eq 0 ] && continue
    echo "===== NOT-READY sandbox: $pod (ready=$ready restarts=$restarts) ====="
    kubectl -n agent-sandbox describe "$pod" || true
    kubectl -n agent-sandbox logs "$pod" --tail=200 || true
    name=${pod#pod/}
    # The pod spec as applied and the owning Sandbox CR: an instant exit is usually
    # explained by what the pod was given.
    echo "===== POD YAML: $pod ====="
    kubectl -n agent-sandbox get "$pod" -o yaml || true
    echo "===== SANDBOX CR: $name ====="
    kubectl -n agent-sandbox get sandboxes.agents.x-k8s.io "$name" -o yaml || true
    # Events for this object only, since the namespace-wide tail above is capped.
    echo "===== EVENTS: $name ====="
    kubectl -n agent-sandbox get events --field-selector involvedObject.name="$name" \
      --sort-by=.lastTimestamp || true
    [ "${restarts:-0}" -gt 0 ] || continue
    echo "===== PREVIOUS container log: $pod (restarts=$restarts) ====="
    # --timestamps so the boot sequence lines up against the runtime log below.
    kubectl -n agent-sandbox logs "$pod" --previous --timestamps --tail=400 || true
  done
  # A healthy sandbox from the same cluster, captured only when a broken one
  # exists, to diff against.
  bad=$(kubectl -n agent-sandbox get pods -o json 2>/dev/null \
    | jq -r ".items[] | select(.metadata.name | startswith(\"conv-\")) | select((.status.containerStatuses[0].ready != true) or ((.status.containerStatuses[0].restartCount // 0) > 0)) | .metadata.name" | head -1)
  if [ -n "${bad:-}" ]; then
    good=$(kubectl -n agent-sandbox get pods -o json 2>/dev/null \
      | jq -r ".items[] | select(.metadata.name | startswith(\"conv-\")) | select(.status.containerStatuses[0].ready == true) | select((.status.containerStatuses[0].restartCount // 0) == 0) | .metadata.name" | head -1)
    if [ -n "${good:-}" ]; then
      echo "===== HEALTHY PEER YAML: pod/$good (diff against pod/$bad) ====="
      kubectl -n agent-sandbox get "pod/$good" -o yaml || true
      echo "===== SPEC DIFF: $good (healthy) vs $bad (broken) ====="
      kubectl -n agent-sandbox get "pod/$good" -o json > /tmp/good.json 2>/dev/null || true
      kubectl -n agent-sandbox get "pod/$bad"  -o json > /tmp/bad.json  2>/dev/null || true
      # Only the fields that can make systemd die on boot; a whole-object diff is noise.
      for f in .spec.containers[0].securityContext .spec.containers[0].resources .spec.containers[0].volumeMounts .spec.volumes .spec.securityContext .spec.nodeName .status.qosClass; do
        echo "--- $f"
        diff <(jq -S "$f" /tmp/good.json 2>/dev/null) <(jq -S "$f" /tmp/bad.json 2>/dev/null) \
          && echo "    (identical)" || true
      done
    fi
  fi
  # The sandbox journal: systemd PID 1 logs to the journal rather than stdio, so the
  # container log ends at "starting systemd..." and only this says what systemd did.
  # A live container is read via kubectl exec and a crash-looping one by copying the
  # journal files off the PVC via the node; -D rather than --merge because each
  # container start writes under a fresh machine-id directory and --merge is
  # rejected alongside --list-boots/-b.
  JDIR=/workspace/.scooter/journal
  jpods=$(kubectl -n agent-sandbox get pods -o name 2>/dev/null | grep "pod/conv-" | cut -d/ -f2)
  # Say so rather than emit nothing.
  [ -n "$jpods" ] || echo "===== SANDBOX JOURNAL: no conv-* pods found ====="
  for pod in $jpods; do
    restarts=$(kubectl -n agent-sandbox get "pod/$pod" \
      -o jsonpath="{.status.containerStatuses[?(@.name==\"sandbox\")].restartCount}" 2>/dev/null)
    echo "===== SANDBOX JOURNAL: $pod (restarts=${restarts:-?}) ====="
    if kubectl -n agent-sandbox exec "$pod" -c sandbox -- test -d "$JDIR" 2>/dev/null; then
      kubectl -n agent-sandbox exec "$pod" -c sandbox -- \
        journalctl --directory "$JDIR" --no-pager --list-boots 2>&1 | tail -10 || true
      # Priority first: a boot that died says so in err/warning before anything else.
      echo "--- priority<=4 (merged, all retained boots) ---"
      kubectl -n agent-sandbox exec "$pod" -c sandbox -- \
        journalctl --directory "$JDIR" --no-pager -p 4 2>&1 | tail -80 || true
      echo "--- tail of the PREVIOUS boot (the one that died, if it restarted) ---"
      kubectl -n agent-sandbox exec "$pod" -c sandbox -- \
        journalctl --directory "$JDIR" --no-pager -b -1 2>&1 | tail -120 \
        || echo "(no prior boot retained)"
    else
      echo "(cannot exec -- container not running; reading the PVC off the node)"
      # local-path puts the claim at <storage>/pvc-<uid>_agent-sandbox_workspace-<pod>.
      for node in $(docker ps --format "{{.Names}}" 2>/dev/null | grep "^k3d-" || true); do
        d=$(docker exec "$node" sh -c "ls -d /var/lib/rancher/k3s/storage/*_agent-sandbox_workspace-$pod 2>/dev/null" 2>/dev/null | head -1)
        [ -n "$d" ] || continue
        echo "--- claim on $node: $d ---"
        jfs=$(docker exec "$node" sh -c "ls $d/.scooter/journal/*/*.journal 2>/dev/null" 2>/dev/null | head -8)
        # A claim header with nothing under it would look like a section that never ran.
        [ -n "$jfs" ] || echo "(no journal on the claim -- systemd exited before journald wrote; stdout above is the only record)"
        for jf in $jfs; do
          local_jf=/tmp/dump-$pod-$(basename "$(dirname "$jf")").journal
          docker exec "$node" sh -c "cat $jf" > "$local_jf" 2>/dev/null || continue
          echo "--- $jf ($(stat -c %s "$local_jf" 2>/dev/null) bytes) ---"
          journalctl --file "$local_jf" --no-pager -p 4 2>&1 | tail -60 || true
        done
      done
    fi
  done
  # The k3d nodes share the kernel of this runner, so cgroup exhaustion or a
  # kernel-side refusal lands here.
  echo "===== KERNEL RING BUFFER (host runner; k3d nodes share this kernel) ====="
  # CNI bridge churn is dropped before the tail, since a sandbox pod emits several
  # veth lines per create and delete.
  (dmesg --ctime 2>/dev/null || sudo -n dmesg --ctime 2>/dev/null || echo "(dmesg unavailable)") \
    | grep -vE "cni0: port [0-9]+\(veth|device veth[0-9a-f]+ (entered|left) promiscuous mode|ADDRCONF\(NETDEV_CHANGE\)" \
    | tail -120 || true
  # A container that dies the second it started failed below the kubelet, and the
  # k3s log inside each node container carries kubelet + containerd + runc; an
  # unreachable daemon is reported loudly rather than skipped.
  if ! docker info >/dev/null 2>&1; then
    echo "===== RUNTIME LOG: UNAVAILABLE -- docker CLI present but daemon unreachable ====="
    docker info 2>&1 | head -5 || true
  else
    for node in $(docker ps --format "{{.Names}}" 2>/dev/null | grep "^k3d-" || true); do
      echo "===== RUNTIME LOG: $node (kubelet/containerd/runc) ====="
      # Kubelet backoff repeats are dropped before the tail, since they are a
      # consequence of the first crash and would fill the window.
      docker logs --tail=20000 "$node" 2>&1 \
        | grep -ivE "pod_workers.go|RemoveStaleState|pod_startup_latency_tracker|reconciler_common.go|replica_set.go|MountVolume.(MountDevice|SetUp) succeeded" \
        | grep -iE "conv-|runc|exit status|exit code|oci runtime|cgroup|back-?off|StartContainer|CreateContainer|RunPodSandbox|killing container|failed to (create|start|run)|sandbox|no space|device or resource busy|permission denied" \
        | tail -200 || true
      echo "===== CRI VIEW: $node ====="
      # crictl sees the dead container after kubectl has moved on, including the OCI
      # config handed to runc; k3s ships crictl.
      docker exec "$node" sh -c "crictl ps -a 2>/dev/null || k3s crictl ps -a 2>/dev/null" \
        | grep -E "conv-|CONTAINER" | head -40 || true
      for cid in $(docker exec "$node" sh -c "crictl ps -a -q 2>/dev/null || k3s crictl ps -a -q 2>/dev/null" 2>/dev/null | head -40); do
        nm=$(docker exec "$node" sh -c "crictl inspect $cid 2>/dev/null || k3s crictl inspect $cid 2>/dev/null" 2>/dev/null \
          | jq -r ".status.labels[\"io.kubernetes.pod.name\"] // empty" 2>/dev/null)
        case "${nm:-}" in conv-*) ;; *) continue ;; esac
        st=$(docker exec "$node" sh -c "crictl inspect $cid 2>/dev/null || k3s crictl inspect $cid 2>/dev/null" 2>/dev/null \
          | jq -r ".status.state // empty" 2>/dev/null)
        case "${st:-}" in CONTAINER_EXITED) ;; *) continue ;; esac
        echo "===== CRI INSPECT: $nm ($cid) ====="
        docker exec "$node" sh -c "crictl inspect $cid 2>/dev/null || k3s crictl inspect $cid 2>/dev/null" 2>/dev/null \
          | jq "{state:.status.state, exitCode:.status.exitCode, reason:.status.reason, message:.status.message, startedAt:.status.startedAt, finishedAt:.status.finishedAt, logPath:.status.logPath}" || true
      done
    done
  fi
  # The step runs under `bash -e`; a trailing failed test would fail the dump.
  true
'
