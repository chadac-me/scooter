#!/usr/bin/env bash
# PR-vs-merge-base pyperf runs per touched suite. Usage: <base-ref> <out-dir>
set -euo pipefail

base_ref=$1 out=$2
mkdir -p "$out"
work=$(mktemp -d)

git diff --name-only "$base_ref"...HEAD > "$work/changed.txt"
node scripts/bench-compare.mjs select --changed "$work/changed.txt" > "$out/suites.txt"
if [ ! -s "$out/suites.txt" ]; then
  echo "bench-ab: no suite's paths changed" >&2
  exit 0
fi

base_tree=$work/base
git worktree add --detach "$base_tree" "$(git merge-base "$base_ref" HEAD)" >&2
trap 'git worktree remove --force "$base_tree"' EXIT

while read -r id app src noise; do
  nix build ".#$app" --no-link >&2 < /dev/null
  [ -d "$base_tree/$src" ] || touch "$out/$id.nobase"
  # ABBA halves, so runner warm-up favours neither side.
  for side in base pr pr base; do
    if [ "$side" = base ]; then
      [ ! -e "$out/$id.nobase" ] || continue
      tree=$base_tree
    else
      [ ! -e "$out/$id.failed" ] || continue
      tree=$PWD
    fi
    echo "bench-ab: $id ($side)" >&2
    if ! nix run ".#$app" -- --src "$tree/$src" --processes 2 --quiet \
      --append "$out/$id.$side.json" < /dev/null >&2; then
      if [ "$side" = base ]; then touch "$out/$id.nobase"; else touch "$out/$id.failed"; fi
    fi
  done
  if [ ! -e "$out/$id.nobase" ] && [ ! -e "$out/$id.failed" ]; then
    nix run ".#$app" -- compare_to "$out/$id.base.json" "$out/$id.pr.json" \
      --table --table-format md --min-speed "$noise" > "$out/$id.md" < /dev/null
  fi
done < "$out/suites.txt"
