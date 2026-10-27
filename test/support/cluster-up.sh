#!/usr/bin/env bash
# Bring up a local Kubernetes cluster for the Tier 2/3 tests, install the
# agent-sandbox controller and CRDs, build and import the images, and apply the
# platform manifests. PROVIDER is one of existing, k3s (default), kind, minikube
# or k3d; `existing` uses the current kubectl context and skips bootstrap. Every
# step checks before acting, so the script is safe to re-run.

set -euo pipefail

PROVIDER="${1:-k3s}"
CLUSTER_NAME="agent-sandbox"
# Where the k3d kubeconfig is written, so callers do not depend on ~/.kube/config.
K3D_KUBECONFIG="${K3D_KUBECONFIG:-/tmp/scooter-k3d.kubeconfig}"
NAMESPACE="${SANDBOX_NAMESPACE:-agent-sandbox}"
# The agent-sandbox release used for the controller and CRDs; the provisioners target its v1beta1 API.
AGENT_SANDBOX_VERSION="${AGENT_SANDBOX_VERSION:-v0.5.2}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log() { echo "[cluster-up] $*"; }

# ---------------------------------------------------------------------------
# 1. Cluster
# ---------------------------------------------------------------------------
# Refuse to apply CRDs and RBAC to anything but a clearly local context unless ALLOW_NONLOCAL_CLUSTER=1.
guard_local_context() {
  local ctx; ctx="$(kubectl config current-context 2>/dev/null || echo '')"
  if [ "${ALLOW_NONLOCAL_CLUSTER:-0}" = "1" ]; then return; fi
  case "$ctx" in
    *k3s*|*kind*|*minikube*|*k3d*|default|"") return ;;
    *)
      echo "[cluster-up] REFUSING to run against non-local context '$ctx'." >&2
      echo "[cluster-up] These tests install CRDs/RBAC and must not touch remote clusters." >&2
      echo "[cluster-up] Use a local provider (k3s/kind/...), switch context, or set" >&2
      echo "[cluster-up] ALLOW_NONLOCAL_CLUSTER=1 to override deliberately." >&2
      exit 1
      ;;
  esac
}

bring_up_cluster() {
  case "$PROVIDER" in
    existing)
      log "using current kubectl context: $(kubectl config current-context 2>/dev/null || echo '?')"
      guard_local_context
      ;;
    k3s)
      if kubectl get nodes >/dev/null 2>&1; then
        log "k3s: a cluster is already reachable; reusing it"
        return
      fi
      if ! command -v k3s >/dev/null 2>&1; then
        log "k3s not installed. Install it (needs root):"
        log "    curl -sfL https://get.k3s.io | sh -"
        log "then: export KUBECONFIG=/etc/rancher/k3s/k3s.yaml (and chmod read access)"
        exit 1
      fi
      log "starting k3s..."
      sudo k3s server --write-kubeconfig-mode 644 >/tmp/k3s.log 2>&1 &
      export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
      wait_for_nodes
      ;;
    kind)     ensure_cmd kind; kind get clusters | grep -qx "$CLUSTER_NAME" || kind create cluster --name "$CLUSTER_NAME" ;;
    minikube) ensure_cmd minikube; minikube status -p "$CLUSTER_NAME" >/dev/null 2>&1 || minikube start -p "$CLUSTER_NAME" ;;
    k3d)
      ensure_cmd k3d
      # New clusters get the scooter registry attached for direct skopeo pushes; an existing cluster is left as is.
      if ! k3d cluster list | grep -q "$CLUSTER_NAME"; then
        k3d registry list 2>/dev/null | grep -q "k3d-scooter-reg.localhost" \
          || k3d registry create scooter-reg.localhost --port 5800
        # k3s >= 1.33 for user-namespaced sandboxes (sandboxUserNamespace, default on).
        k3d cluster create "$CLUSTER_NAME" --image rancher/k3s:v1.35.4-k3s1 --registry-use k3d-scooter-reg.localhost:5800
      fi
      # Write and export a kubeconfig of our own, since k3d's merge into ~/.kube/config can fail silently.
      k3d kubeconfig get "$CLUSTER_NAME" > "$K3D_KUBECONFIG"
      export KUBECONFIG="$K3D_KUBECONFIG"
      log "KUBECONFIG=$KUBECONFIG (k3d; export this for kubectl in your shell)"
      ;;
    *) echo "unknown provider: $PROVIDER" >&2; exit 1 ;;
  esac
}

wait_for_nodes() {
  log "waiting for a Ready node..."
  for _ in $(seq 1 60); do
    if kubectl get nodes 2>/dev/null | grep -q " Ready "; then return; fi
    sleep 2
  done
  echo "[cluster-up] cluster did not become Ready" >&2; exit 1
}

ensure_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "[cluster-up] missing: $1" >&2; exit 1; }; }

# ---------------------------------------------------------------------------
# 2. agent-sandbox controller + CRDs
# ---------------------------------------------------------------------------
install_controller() {
  guard_local_context
  if kubectl get crd sandboxes.agents.x-k8s.io >/dev/null 2>&1; then
    log "agent-sandbox CRDs already present"
    return
  fi
  log "installing agent-sandbox $AGENT_SANDBOX_VERSION (controller + extensions)"
  local base="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}"
  kubectl apply -f "${base}/sandbox.yaml"
  kubectl apply -f "${base}/extensions.yaml"
  kubectl wait --for=condition=Available deploy --all -n agent-sandbox-system --timeout=180s || true
}

# ---------------------------------------------------------------------------
# 3. Images (generic sandbox + NixOS dev sandbox), built with Nix, imported.
# ---------------------------------------------------------------------------
# Import one image-archive tarball into the cluster, provider-agnostic.
import_tarball() {
  local tarball="$1"
  case "$PROVIDER" in
    k3s)      sudo k3s ctr images import "$tarball" ;;
    kind)     kind load image-archive "$tarball" --name "$CLUSTER_NAME" ;;
    k3d)      k3d image import "$tarball" -c "$CLUSTER_NAME" ;;
    minikube) minikube -p "$CLUSTER_NAME" image load "$tarball" ;;
    existing) log "existing cluster: ensure the image is reachable (push to a registry)" ;;
  esac
}

# Build a nix2container flake image target into a docker-archive tarball and import it, warning and skipping if the build fails.
build_and_import() {
  local target="$1" label="$2" tarball
  log "building $label image with Nix..."
  tarball="$(mktemp --suffix=.tar)"
  if ! (cd "$REPO_ROOT" && nix run "${target}.copyTo" -- "docker-archive:${tarball}" >/dev/null 2>&1); then
    log "WARN: $label image build not available; skipping import"
    rm -f "$tarball"
    return
  fi
  import_tarball "$tarball"
  rm -f "$tarball"
}

import_images() {
  # The NixOS dev-environment sandbox, with the local-overlay writable Nix store on.
  build_and_import ".#sandbox-os-image" "NixOS dev sandbox (overlay store always on)"
}

# ---------------------------------------------------------------------------
# 4. Platform manifests (namespace, RBAC, agent-host) from kubenix.
# ---------------------------------------------------------------------------
apply_platform() {
  guard_local_context
  log "rendering kubenix platform manifests..."
  local manifests
  manifests="$(cd "$REPO_ROOT" && nix build .#platform-manifests --no-link --print-out-paths 2>/dev/null || true)"
  if [ -z "$manifests" ]; then
    log "WARN: platform manifest render failed; creating namespace only"
    kubectl get ns "$NAMESPACE" >/dev/null 2>&1 || kubectl create ns "$NAMESPACE"
    return
  fi
  log "applying platform manifests ($manifests)"
  kubectl apply -f "$manifests"
  kubectl -n "$NAMESPACE" rollout status deploy/agent-host --timeout=120s || true
}

main() {
  bring_up_cluster
  install_controller
  import_images
  apply_platform
  log "done (provider=$PROVIDER, namespace=$NAMESPACE)"
}

main "$@"
