#!/usr/bin/env bash
# image-sizes.sh — measure the on-disk size of every shipped container image and
# emit it as JSON for the CI image-size benchmark. Every image is a nix2container
# recipe that references the store paths which become the pushed layers, so the
# size is `nix path-info -S` (total closure size) of that recipe. Build logs go to
# stderr so stdout stays pure JSON; Cachix substitutes unchanged images.
#
# Usage:
#   scripts/image-sizes.sh                                # measure all images
#   scripts/image-sizes.sh agent-host-image broker-image  # a subset
set -euo pipefail

# attr -> measurement kind (`closure` = `nix path-info -S` of the n2c recipe,
# `tarball` = the file's own size); keep in sync with the publish-images.yml
# matrix, which ci's image-coverage check enforces.
declare -A KIND=(
  [sandbox-os-image]=closure
  [agent-host-image]=closure
  [broker-image]=closure
  [webhooks-image]=closure
  [db-migrator-image]=closure
  [ui-image]=closure
  [scheduler-image]=closure
  [byoc-controller-image]=closure
  [conversation-controller-image]=closure
  [conversation-router-image]=closure
  [warm-store-controller-image]=closure
  # Published but not module-referenced: the claude-baked agent-host variant and
  # the remote-agent image users run on their own machines.
  [agent-host-image-claude]=closure
  [remote-agent-image]=closure
)

# Default to all images (stable order); allow a subset via argv.
if [ "$#" -gt 0 ]; then
  IMAGES=("$@")
else
  IMAGES=(
    sandbox-os-image agent-host-image broker-image webhooks-image ui-image scheduler-image
    byoc-controller-image conversation-controller-image conversation-router-image
    warm-store-controller-image agent-host-image-claude remote-agent-image
  )
fi

measure_one() {
  local attr="$1" kind="${KIND[$1]:-}"
  if [ -z "$kind" ]; then
    echo "image-sizes: unknown image '$attr' (not in KIND map)" >&2
    return 1
  fi
  echo "==> building .#$attr ($kind)" >&2
  # The claude-baked images contain the unfree `claude` CLI, so they need
  # NIXPKGS_ALLOW_UNFREE + --impure.
  local impure=()
  case "$attr" in
    *-claude|remote-agent-image) export NIXPKGS_ALLOW_UNFREE=1; impure=(--impure) ;;
  esac
  # `--print-out-paths` prints the store path on stdout and build logs on stderr.
  # Explicit `|| return 1` throughout: the caller runs this as `if ! measure_one`,
  # which disables `set -e` inside the function, so a failed build would
  # otherwise fall through and print `"bytes":,` (invalid JSON) instead of
  # being skipped.
  local out
  out=$(nix build "${impure[@]}" ".#$attr" --no-link --print-out-paths --print-build-logs) || return 1

  local bytes
  case "$kind" in
    tarball)
      # The .tar.gz IS the pushed image — measure the file.
      bytes=$(stat -c%s "$out") || return 1
      ;;
    closure)
      # nix2container: the recipe references the layer closure — measure it.
      bytes=$(nix path-info -S "$out" | awk '{print $2}') || return 1
      ;;
  esac
  case "$bytes" in
    '' | *[!0-9]*)
      echo "image-sizes: no size for '$attr' (got '$bytes')" >&2
      return 1
      ;;
  esac
  printf '{"name":"%s","bytes":%s,"kind":"%s"}\n' "$attr" "$bytes" "$kind"
}

# Collect one JSON object per image, then fold into a sorted array.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
for attr in "${IMAGES[@]}"; do
  # The baseline run measures origin/main, which may predate a newly added image,
  # so it skips a failed image. IMAGE_SIZES_STRICT=1 (the PR side) fails instead,
  # since there a failure is a broken build rather than a missing attr.
  if ! measure_one "$attr" >> "$tmp"; then
    if [ "${IMAGE_SIZES_STRICT:-0}" = 1 ]; then
      echo "image-sizes: '$attr' failed to build" >&2
      exit 1
    fi
    echo "image-sizes: skipping '$attr' (not in this flake — new image?)" >&2
  fi
done

jq -s 'sort_by(.name)' "$tmp"
