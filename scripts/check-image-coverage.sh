#!/usr/bin/env bash
# check-image-coverage.sh — every image a module tells a deploy to pull must be
# published, every published image must be size-benchmarked and in the multi-arch
# manifest job, and every cluster image must have a ghcrImages content-tag ref.
set -uo pipefail
cd "$(dirname "$0")/.." || exit

fail=0
note() { echo "  - $1"; fail=1; }

# What the modules tell deploys to pull (the registryPrefix defaults).
mapfile -t referenced < <(
  grep -rhoE '\$\{cfg\.registryPrefix\}[a-z-]+' modules/*.nix \
    | sed 's/${cfg.registryPrefix}//' | sort -u
)
# What CI publishes to ghcr: the publish job's `image:` axis; the manifest job's
# own `{ image: … }` list is cross-checked below.
mapfile -t published < <(
  grep -oE '\{ name: [a-z-]+' .github/workflows/publish-images.yml \
    | sed 's/{ name: //' | sort -u
)
# What the size benchmark measures, keyed by flake attr, since stripping "-image"
# breaks on agent-host-image-claude.
mapfile -t benchmarked < <(
  grep -oE '^\s+\[[a-z-]+\]=' scripts/image-sizes.sh | tr -d ' []=' | sort -u
)

echo "referenced by modules: ${#referenced[@]} | published: ${#published[@]} | benchmarked: ${#benchmarked[@]}"

echo "modules reference an image that is never published:"
for r in "${referenced[@]}"; do
  # agent-sandbox-os is the sandbox image; it publishes under that exact name.
  printf '%s\n' "${published[@]}" | grep -qx "$r" || note "$r (add it to publish-images.yml's matrix)"
done
[ "$fail" = 0 ] && echo "  (none)"

# Compare on the attr side, since attr names differ from image names (ui-image ->
# agent-sandbox-ui).
echo "published images missing from the size benchmark:"
missing_bench=0
while read -r img attr; do
  printf '%s\n' "${benchmarked[@]}" | grep -qx "$attr" || {
    echo "  - $img (attr $attr not in scripts/image-sizes.sh KIND map)"; missing_bench=1; fail=1
  }
done < <(grep -oE '\{ name: [a-z-]+, attr: [a-z-]+' .github/workflows/publish-images.yml \
          | sed 's/{ name: //;s/, attr:/ /')
[ "$missing_bench" = 0 ] && echo "  (none)"

# Every published image must also be in the manifest job, or its per-arch tags are
# pushed and never joined into the shared tag.
echo "published images missing from the multi-arch manifest job:"
mapfile -t manifested < <(
  awk '/^  manifest:/,0' .github/workflows/publish-images.yml \
    | grep -oE '\{ image: [a-z-]+' | sed 's/{ image: //' | sort -u
)
missing_manifest=0
for img in "${published[@]}"; do
  printf '%s\n' "${manifested[@]}" | grep -qx "$img" || {
    echo "  - $img (add it to the manifest job's matrix)"; missing_manifest=1; fail=1
  }
done
[ "$missing_manifest" = 0 ] && echo "  (none)"

# Every published image must have a content-tagged ref in ghcrImages, or the ghcr
# render falls back to the module default `:latest`.
echo "published images missing a ghcrImages content-tag ref:"
missing_ref=0
refs_json=$(nix build .#ghcr-image-refs --no-link --print-out-paths 2>/dev/null)
if [ -n "$refs_json" ] && [ -f "$refs_json" ]; then
  for img in "${published[@]}"; do
    # agent-host-claude is split out for the unfree eval (ghcrImageClaude) and
    # remote-agent is never referenced by a cluster manifest.
    case "$img" in agent-host-claude|remote-agent) continue ;; esac
    grep -q "/${img}:" "$refs_json" || {
      echo "  - $img (add it to ghcrImages in flake.nix, else the ghcr render uses :latest)"
      missing_ref=1; fail=1
    }
  done
  [ "$missing_ref" = 0 ] && echo "  (none)"
else
  echo "  (skipped — could not build .#ghcr-image-refs)"
fi

exit "$fail"
