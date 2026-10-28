#!/usr/bin/env bash
# Interleaved PR-vs-merge-base benchmark rounds. Usage: <base-ref> <out.jsonl> [rounds]
set -euo pipefail

base_ref=$1 out=$2 rounds=${3:-10}
: > "$out"
work=$(mktemp -d)

git diff --name-only "$base_ref"...HEAD > "$work/changed.txt"
node scripts/bench-compare.mjs select --changed "$work/changed.txt" > "$work/suites.txt"
if [ ! -s "$work/suites.txt" ]; then
  echo "bench-ab: no suite's paths changed" >&2
  exit 0
fi

base_tree=$work/base
git worktree add --detach "$base_tree" "$(git merge-base "$base_ref" HEAD)" >&2
trap 'git worktree remove --force "$base_tree"' EXIT

# Each app prints its registry id as `suite`.
while read -r id app src _noise; do
  nix build ".#$app" --no-link >&2 < /dev/null
  have_base=1
  if [ ! -d "$base_tree/$src" ]; then
    have_base=0
    printf '{"suite": "%s", "side": "base", "failed": true}\n' "$id" >> "$out"
  fi
  for ((i = 1; i <= rounds; i++)); do
    # Alternate who goes first, so warm-up favours neither side.
    if ((i % 2)); then order="base pr"; else order="pr base"; fi
    for side in $order; do
      [ "$side" = pr ] || [ "$have_base" = 1 ] || continue
      if [ "$side" = base ]; then tree=$base_tree; else tree=$PWD; fi
      echo "bench-ab: $id round $i/$rounds ($side)" >&2
      if ! nix run ".#$app" -- --src "$tree/$src" --side "$side" >> "$out" < /dev/null; then
        printf '{"suite": "%s", "side": "%s", "failed": true}\n' "$id" "$side" >> "$out"
        # A failing side stops; a failing PR ends the suite.
        if [ "$side" = base ]; then have_base=0; else break 2; fi
      fi
    done
  done
done < "$work/suites.txt"
