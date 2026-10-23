#!/usr/bin/env bash
# db-sql-dir.sh — print a database's SQL directory (schema.sql + migrations/ +
# atlas.hcl), relative to the repo root. Core databases are the sections of the
# generated lib/sql/owners.toml and live in lib/sql/<db>. A contrib's database is
# the section of its own generated contrib/<name>/sql/owners.toml and lives there,
# so core files never name a contrib.
#
# Usage: scripts/db-sql-dir.sh <db>        -> the directory
#        scripts/db-sql-dir.sh --core      -> the core databases, space-separated
#        scripts/db-sql-dir.sh --all       -> every database, core then contrib
set -euo pipefail
cd "$(dirname "$0")/.."

# The top-level [<db>] sections of one owners.toml.
sections() { sed -n 's/^\[\([a-z_][a-z_0-9]*\)\]$/\1/p' "$1"; }

# Emits "<db> <dir>" per database.
dirs() {
  sections lib/sql/owners.toml | awk '{ print $1, "lib/sql/" $1 }'
  for f in contrib/*/sql/owners.toml; do
    [ -e "$f" ] || continue
    sections "$f" | awk -v d="$(dirname "$f")" '{ print $1, d }'
  done
}

case "${1:-}" in
  --core) dirs | awk '$2 == "lib/sql/" $1 { print $1 }' | tr '\n' ' '; exit 0 ;;
  --all) dirs | awk '{ print $1 }' | tr '\n' ' '; exit 0 ;;
esac
dir="$(dirs | awk -v db="${1:?usage: db-sql-dir.sh <db> | --core | --all}" '$1 == db { print $2 }')"
[ -n "$dir" ] || { echo "db-sql-dir.sh: no database '$1' in lib/sql/owners.toml or contrib/*/sql/owners.toml" >&2; exit 1; }
echo "$dir"
