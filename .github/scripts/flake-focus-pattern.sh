#!/usr/bin/env bash
# Extract the focused-flake contract from a PR description for the `flake-focus`
# CI jobs (see .github/workflows/ci.yml). The PR body names the test with
# `flake-test: <playwright -g pattern>` and may add `flake-specs: <spec files>`
# for flakes that only reproduce under cross-spec contention, in which case the
# job runs those files together instead of the whole suite filtered to the
# pattern. The pattern must name a real test title even on the contention path,
# where it is not passed to `-g`, because the verdict is resolved against the
# report (scripts/flake-focus-report.mjs).
#
# Three further keys tune the experiment itself, because a focused run's default
# budget is often too small to make the flake fire at all — and a run where the
# flake fires on neither the PR nor the control proves nothing (the
# `⚠️ no power` verdict). They live in the PR description, not in this
# workflow, so anyone can raise the budget on their own flake without a CI
# change:
#
#   flake-repeat: <n>        repetitions per test on the FAST job   (cap 100)
#   flake-full-repeat: <n>   repetitions per test on the FULL job   (cap 20)
#   flake-mode: targeted|contention
#                            force the path instead of inferring it from
#                            `flake-specs:` — `targeted` runs the `-g` match
#                            alone even when specs are named (the bigger default
#                            budget), `contention` requires specs
#
# The two repeat keys are deliberately per-target: a repetition on the fast stack
# is a browser against fakes, while a full one boots a real sandbox pod on the
# shared fleet, so one number must not silently apply to both.
#
# Emits `pattern=`, `specs=`, `specs_full=`, `specs_run=`, `mode=` and `repeat=`
# to $GITHUB_OUTPUT, and fails when the label is set but no `flake-test:` line
# exists, or when a tuning key is malformed.
set -euo pipefail

body="${PR_BODY:-}"

# FULL_TARGET=1 when called from `flake-focus-full`: it selects the full-target
# allowlist, budget and cap below.
full_target=0
[[ "${FULL_TARGET:-}" == "1" ]] && full_target=1

# Default repetition budgets. Targeted runs one test, so it can afford many;
# contention runs whole spec files, so each repetition is several tests. The full
# target pays a real sandbox pod and a cold boot per repetition, hence the step
# down.
if (( full_target )); then
  default_repeat_targeted=5
  default_repeat_contention=3
  repeat_cap=20
  repeat_key='flake-full-repeat'
else
  default_repeat_targeted=20
  default_repeat_contention=5
  repeat_cap=100
  repeat_key='flake-repeat'
fi

# First value of `<key>:` in the body, stripped of the key, whitespace and
# wrapping backticks/quotes.
pr_key() {
  printf '%s\n' "$body" \
    | { grep -iE "^[[:space:]]*$1:" || true; } \
    | head -n1 \
    | sed -E "s/^[[:space:]]*[^:]+:[[:space:]]*//; s/^[\`\"']+//; s/[\`\"']+[[:space:]]*\$//; s/[[:space:]]+\$//"
}

pattern="$(pr_key 'flake-test')"

if [[ -z "$pattern" ]]; then
  echo "::error::The 'flake-check' label is set but the PR description has no" \
       "'flake-test: <pattern>' line. Add e.g. 'flake-test: multi-turn re-render'" \
       "so the focused check knows which test to run 20×."
  exit 1
fi

echo "Focused flake pattern: '$pattern'"
echo "pattern=$pattern" >>"$GITHUB_OUTPUT"

# Optional `flake-specs:` line, sanitised to `test/e2e/*.spec.ts` tokens so a
# malformed body cannot inject shell args.
specs_raw="$(pr_key 'flake-specs')"
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
# intersection; whether an empty intersection is fatal depends on the mode
# resolved below.
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

# The specs this invocation would actually run, before `flake-mode:` has its say.
specs_here="$specs"
(( full_target )) && specs_here="$specs_full"

# Mode: inferred from `flake-specs:`, overridable. The override exists because
# naming specs used to be the only way to ask for contention *and* silently
# bought the smaller budget — a PR that wants the lone test hammered at the
# targeted budget can now say so while keeping the specs line for the record.
mode_raw="$(pr_key 'flake-mode')"
mode=""
case "${mode_raw,,}" in
  "")                 mode="" ;;
  targeted)           mode=targeted ;;
  contention)         mode=contention ;;
  *)
    echo "::error::'flake-mode: $mode_raw' is not valid — use 'targeted' or 'contention'."
    exit 1
    ;;
esac

if [[ -z "$mode" ]]; then
  mode=targeted
  [[ -n "$specs_here" ]] && mode=contention
  # A PR that named specs asked for contention, so an empty intersection is a
  # mistake to report, not a quiet downgrade to the targeted path. Only an
  # explicit `flake-mode: targeted` buys that downgrade (handled above).
  if [[ -n "$specs" && -z "$specs_here" ]]; then
    mode=contention
  fi
fi

specs_run=""
if [[ "$mode" == contention ]]; then
  specs_run="$specs_here"
  if [[ -z "$specs_run" ]]; then
    if (( full_target )) && [[ -n "$specs" ]]; then
      echo "::error::'flake-specs:' names only specs that are NOT on the full-target" \
           "allowlist (test/e2e/full-specs.json), so the full flake check would run" \
           "nothing. Add the spec to full-specs.json, or drop the" \
           "'e2e-full-flake-check' label and rely on the fast one."
    else
      echo "::error::'flake-mode: contention' needs a 'flake-specs: <files>' line naming" \
           "the spec files to run together. Drop the mode line to hammer the" \
           "'flake-test:' match on its own instead."
    fi
    exit 1
  fi
fi
echo "Focused flake mode: '$mode' (specs to run: '${specs_run}')"
echo "mode=$mode" >>"$GITHUB_OUTPUT"
echo "specs_run=$specs_run" >>"$GITHUB_OUTPUT"

# Budget: the mode's default, overridden by this target's repeat key. Rejected
# loudly rather than clamped, so the PR says what actually ran.
repeat="$default_repeat_targeted"
[[ "$mode" == contention ]] && repeat="$default_repeat_contention"
repeat_raw="$(pr_key "$repeat_key")"
if [[ -n "$repeat_raw" ]]; then
  if [[ ! "$repeat_raw" =~ ^[0-9]+$ ]] || (( repeat_raw < 1 )); then
    echo "::error::'$repeat_key: $repeat_raw' is not a positive integer."
    exit 1
  fi
  if (( repeat_raw > repeat_cap )); then
    echo "::error::'$repeat_key: $repeat_raw' exceeds the cap of $repeat_cap for this" \
         "target. A focused job holds a runner (and, on the full target, the shared" \
         "k3d fleet) for the whole run, and the control run doubles it. Split the" \
         "experiment across re-runs instead."
    exit 1
  fi
  repeat="$repeat_raw"
  echo "::notice::repetition budget overridden from the PR description: $repeat_key: $repeat"
fi
echo "Focused flake repetitions: $repeat (per test, mode=$mode)"
echo "repeat=$repeat" >>"$GITHUB_OUTPUT"
