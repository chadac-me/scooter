#!/usr/bin/env bash
# Extract the focused-flake test pattern from a PR description for the
# `flake-focus` CI jobs (see .github/workflows/ci.yml). The PR body names the
# test with `flake-test: <playwright -g pattern>` and may add
# `flake-specs: <spec files>` for flakes that need the cluster worked first, in
# which case the job runs those files together instead of the whole suite
# filtered to the pattern. The pattern must name a real test title
# even on the contention path, where it is not passed to `-g`, because the
# verdict is resolved against the report (scripts/flake-focus-report.mjs).
# `flake-repeat: <n>` overrides the job's repetition budget, which is the knob
# the report names when a run comes back with no power.
# Emits `pattern=`, `specs=`, `specs_full=` and `repeat=` to $GITHUB_OUTPUT, and
# fails when the label is set but no `flake-test:` line exists.
set -euo pipefail

body="${PR_BODY:-}"

# First `flake-test:` line, stripped of the key, whitespace and wrapping
# backticks/quotes.
pattern="$(
  printf '%s\n' "$body" \
    | grep -iE '^[[:space:]]*flake-test:' \
    | head -n1 \
    | sed -E 's/^[[:space:]]*flake-test:[[:space:]]*//I; s/^[`"'"'"']+//; s/[`"'"'"']+[[:space:]]*$//; s/[[:space:]]+$//'
)"

if [[ -z "$pattern" ]]; then
  echo "::error::The 'flake-check' label is set but the PR description has no" \
       "'flake-test: <pattern>' line. Add e.g. 'flake-test: multi-turn re-render'" \
       "so the focused check knows which test to run 20×."
  exit 1
fi

echo "Focused flake pattern: '$pattern'"
echo "pattern=$pattern" >>"$GITHUB_OUTPUT"

# Optional `flake-repeat:` line — the repetition budget. A clean run whose control
# was also clean has no power, and the budget is the knob that buys it back; before
# this existed the only way to turn it was editing the job's defaults for every PR.
# Emitted empty when absent, so the workflow's `|| '<default>'` keeps the defaults.
repeat_raw="$(
  printf '%s\n' "$body" \
    | { grep -iE '^[[:space:]]*flake-repeat:' || true; } \
    | head -n1 \
    | sed -E 's/^[[:space:]]*flake-repeat:[[:space:]]*//I; s/^[`"'"'"']+//; s/[`"'"'"']+.*$//; s/[[:space:]].*$//'
)"
repeat=""
if [[ -n "$repeat_raw" ]]; then
  # Bounded, and digits-only so the value can never reach a shell as anything else.
  # The ceiling is a cost guard: each full-target repetition is a real sandbox pod,
  # and the control run pays the same budget a second time.
  if [[ "$repeat_raw" =~ ^[0-9]{1,2}$ ]] && ((10#$repeat_raw >= 1 && 10#$repeat_raw <= 40)); then
    repeat="$((10#$repeat_raw))"
  else
    echo "::error::'flake-repeat: $repeat_raw' is not an integer in 1..40. Drop the line" \
         "to use the job's default budget."
    exit 1
  fi
fi
echo "Focused flake repeat budget: '${repeat:-(job default)}'"
echo "repeat=$repeat" >>"$GITHUB_OUTPUT"

# Optional `flake-specs:` line, sanitised to `test/e2e/*.spec.ts` tokens so a
# malformed body cannot inject shell args.
specs_raw="$(
  printf '%s\n' "$body" \
    | { grep -iE '^[[:space:]]*flake-specs:' || true; } \
    | head -n1 \
    | sed -E 's/^[[:space:]]*flake-specs:[[:space:]]*//I'
)"
specs=""
if [[ -n "$specs_raw" ]]; then
  for tok in $specs_raw; do
    tok="${tok#\`}"; tok="${tok%\`}"        # strip wrapping backticks
    if [[ "$tok" =~ ^test/e2e/[A-Za-z0-9._/-]+\.spec\.ts$ ]]; then
      specs="${specs:+$specs }$tok"
    else
      echo "::warning::ignoring non-spec flake-specs token: '$tok'"
    fi
  done
fi
echo "Focused flake specs: '${specs}'"
echo "specs=$specs" >>"$GITHUB_OUTPUT"

# The full target runs an allowlist (test/e2e/full-specs.json), so emit the
# intersection and, when FULL_TARGET=1, fail if the PR named specs but none
# survive.
specs_full=""
allow="$(dirname "$0")/../../test/e2e/full-specs.json"
for tok in $specs; do
  if grep -q "\"$(basename "$tok")\"" "$allow"; then
    specs_full="${specs_full:+$specs_full }$tok"
  else
    echo "::notice::$tok is not on the full-target allowlist — dropped from the full flake run"
  fi
done
echo "Focused flake specs (full allowlist): '${specs_full}'"
echo "specs_full=$specs_full" >>"$GITHUB_OUTPUT"

if [[ "${FULL_TARGET:-}" == "1" && -n "$specs" && -z "$specs_full" ]]; then
  echo "::error::'flake-specs:' names only specs that are NOT on the full-target" \
       "allowlist (test/e2e/full-specs.json), so the full flake check would run" \
       "nothing. Add the spec to full-specs.json, or drop the" \
       "'e2e-full-flake-check' label and rely on the fast one."
  exit 1
fi
