#!/usr/bin/env bash
# image-sizes-diff.sh — render a markdown table comparing PR image sizes against a
# baseline (origin/main) for the CI comment; report-only, it flags growth with an
# emoji but never exits non-zero.
#
# Usage:
#   scripts/image-sizes-diff.sh <baseline.json> <pr.json> [growth_pct_flag]
#     baseline.json / pr.json : the [{name,bytes,kind}] arrays from image-sizes.sh
#     growth_pct_flag         : % growth that earns a ⚠️ (default 5)
#
# Output (stdout): the markdown body of the image-size section; an image present
# on one side only renders "—" on the missing side.
set -euo pipefail

BASELINE="${1:?usage: image-sizes-diff.sh <baseline.json> <pr.json> [growth_pct]}"
PR="${2:?usage: image-sizes-diff.sh <baseline.json> <pr.json> [growth_pct]}"
FLAG_PCT="${3:-5}"

# No marker and no heading of its own: this is one section of the shared CI
# comment, and ci-report.mjs owns the <details> around it.
MARKER=""

# Join baseline and PR by name and render one row each; all arithmetic and
# formatting is done in jq.
jq -rn \
  --slurpfile base "$BASELINE" \
  --slurpfile pr "$PR" \
  --argjson flag "$FLAG_PCT" \
  --arg marker "$MARKER" '
  # bytes -> human (MiB with one decimal; "—" for a missing side)
  def human: if . == null then "—" else (. / 1048576 * 10 | round / 10 | tostring) + " MiB" end;

  ($base[0] // []) as $b | ($pr[0] // []) as $p |
  # index both sides by name
  ($b | map({key:.name, value:.}) | from_entries) as $bi |
  ($p | map({key:.name, value:.}) | from_entries) as $pi |
  # the union of image names, sorted
  (($b + $p) | map(.name) | unique) as $names |

  # per-image row record
  [ $names[] | . as $name |
    ($bi[$name].bytes) as $ob |
    ($pi[$name].bytes) as $nb |
    {
      name: $name,
      base: $ob,
      pr: $nb,
      delta: (if $ob != null and $nb != null then ($nb - $ob) else null end),
      pct: (if $ob != null and $ob > 0 and $nb != null then (($nb - $ob) / $ob * 100) else null end)
    }
  ] as $rows |

  # a row grew past the flag threshold?
  ([ $rows[] | select(.pct != null and .pct >= $flag) ] | length) as $grew |

  # render
  ( "Sizes vs `origin/main` (tarball images = `.tar.gz` file size; nix2container images = closure size). " +
    "⚠️ marks growth ≥ \($flag)%.\n\n" +
    "| Image | main | PR | Δ | Δ% |\n" +
    "|---|--:|--:|--:|--:|\n" +
    ( [ $rows[] |
        (if .pct != null and .pct >= $flag then "⚠️ " else "" end) as $warn |
        (if .delta == null then "—"
         else (if .delta >= 0 then "+" else "" end) + (.delta / 1048576 * 10 | round / 10 | tostring) + " MiB" end) as $dh |
        (if .pct == null then "—"
         else (if .pct >= 0 then "+" else "" end) + (.pct * 10 | round / 10 | tostring) + "%" end) as $ph |
        "| \($warn)`\(.name)` | \(.base | human) | \(.pr | human) | \($dh) | \($ph) |"
      ] | join("\n") ) + "\n\n" +
    (if $grew > 0
     then "⚠️ **\($grew) image(s) grew ≥ \($flag)%.** Confirm the increase is intended."
     else "✅ No image grew ≥ \($flag)%." end) + "\n"
  )
'
