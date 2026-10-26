#!/usr/bin/env bash
# Empty the persisted k3d caches when their volume is short of free space, before
# the cluster comes up. The runner bind-mounts them from the pooled /nix volume and
# nothing else ever prunes them, so content-tagged platform images pile up night
# after night until a run's own image pulls plus `nix develop` push the node past
# the kubelet's ephemeral-storage eviction threshold mid-test.
#
# Both directories are pure caches: an emptied containerd store re-pulls, an
# emptied registry re-pushes. A cache still mounted by a live container is never
# touched. Always exits 0, so a trim problem cannot fail the job by itself.
#
# Env:
#   K3D_MIN_FREE_GB   free space to restore before bring-up (default 25)
#   K3D_CACHE_DIRS    caches to trim, cheapest to lose first
#                     (default "/var/lib/k3d-containerd /var/lib/k3d-registry")
set -uo pipefail

min_free_gb="${K3D_MIN_FREE_GB:-25}"
read -r -a dirs <<<"${K3D_CACHE_DIRS:-/var/lib/k3d-containerd /var/lib/k3d-registry}"

case "$min_free_gb" in
  ''|*[!0-9]*) echo "::warning title=k3d cache trim::K3D_MIN_FREE_GB='$min_free_gb' is not a whole number; skipping"; exit 0 ;;
esac

free_gb() {
  df -Pk "$1" 2>/dev/null | awk 'NR==2 { printf "%d", $4 / 1048576 }'
}

# A cache is busy when a container (running or stopped) bind-mounts it.
busy() {
  docker ps -aq 2>/dev/null | while read -r id; do
    docker inspect -f '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$id" 2>/dev/null
  done | grep -qxF "$1"
}

# The contents are written by root inside the k3d containers, so the wipe runs as
# root from the start: an unprivileged pass deletes only some files, and a registry
# left with manifests whose blobs are gone breaks every later pull.
wipe() {
  if sudo -n true 2>/dev/null; then
    sudo -n find "$1" -mindepth 1 -delete
  else
    docker run --rm --entrypoint find -v "$1:/cache" \
      "${K3D_TRIM_IMAGE:-docker.io/library/registry:2}" /cache -mindepth 1 -delete
  fi
}

for dir in "${dirs[@]}"; do
  [ -d "$dir" ] || continue
  free=$(free_gb "$dir")
  [ -n "$free" ] || { echo "k3d cache trim: cannot read free space for $dir; leaving it"; continue; }
  if [ "$free" -ge "$min_free_gb" ]; then
    echo "k3d cache trim: ${free}G free on $dir's volume (floor ${min_free_gb}G); keeping it"
    continue
  fi
  if busy "$dir"; then
    echo "k3d cache trim: ${free}G free, but $dir is mounted by a live container; keeping it"
    continue
  fi
  used=$(du -sh "$dir" 2>/dev/null | cut -f1)
  if wipe "$dir"; then
    echo "::notice title=k3d cache trim::emptied $dir (${used:-?}): only ${free}G free, floor ${min_free_gb}G; now $(free_gb "$dir")G free"
  else
    echo "::warning title=k3d cache trim::could not empty $dir with ${free}G free; the run may hit disk-pressure eviction"
  fi
done
exit 0
