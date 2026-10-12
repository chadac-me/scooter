#!/usr/bin/env bash
# `bash -n` every script in .github/scripts/. These scripts are only executed by
# jobs that first spend minutes standing up k3d, so a plain syntax error would
# otherwise surface deep into the expensive job. In particular, a single quote
# added inside a `bash -c '<many lines>'` block closes the outer string, which
# shellcheck treats as one opaque word (SC2016) but `bash -n` catches; inside such
# a block use double quotes and escape `$` as `\$`.
set -euo pipefail

cd "$(dirname "$0")"

fail=0
checked=0
for f in *.sh; do
  checked=$((checked + 1))
  if ! bash -n "$f" 2>/tmp/shell-syntax.err; then
    {
      echo "::error file=.github/scripts/$f::does not parse:"
      sed 's/^/    /' /tmp/shell-syntax.err
      echo "    If the error points into a \`bash -c '...'\` block, a nested single"
      echo "    quote has closed it — use double quotes inside and escape \$ as \\\$."
    } >&2
    fail=1
  fi
done

[ "$fail" -eq 0 ] || { echo "shell syntax check FAILED" >&2; exit 1; }
echo "✅ $checked script(s) in .github/scripts/ parse"
