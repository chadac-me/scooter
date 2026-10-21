#!/usr/bin/env bash
# db-sql-dir.sh — print a database's SQL directory (schema.sql + migrations/),
# relative to the repo root, as declared in the generated lib/sql/owners.toml: its
# `sql_dir` (a contrib database, e.g. contrib/files/sql) or lib/sql/<db> (core).
#
# Usage: scripts/db-sql-dir.sh <db>        -> the directory
#        scripts/db-sql-dir.sh --core      -> the core databases, space-separated
set -euo pipefail
cd "$(dirname "$0")/.."

# Emits "<db> <dir>" per top-level [<db>] section.
dirs() {
  awk '
    /^\[[a-z_][a-z_0-9]*\]$/ { if (s != "") print s, (d != "" ? d : "lib/sql/" s); s = substr($0, 2, length($0) - 2); d = "" }
    /^sql_dir = / { d = $3; gsub(/"/, "", d) }
    END { if (s != "") print s, (d != "" ? d : "lib/sql/" s) }
  ' lib/sql/owners.toml
}

if [ "${1:-}" = "--core" ]; then
  dirs | awk '$2 == "lib/sql/" $1 { print $1 }' | tr '\n' ' '
  exit 0
fi
dir="$(dirs | awk -v db="${1:?usage: db-sql-dir.sh <db> | --core}" '$1 == db { print $2 }')"
[ -n "$dir" ] || { echo "db-sql-dir.sh: no database '$1' in lib/sql/owners.toml" >&2; exit 1; }
echo "$dir"
