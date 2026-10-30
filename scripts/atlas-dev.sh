#!/usr/bin/env bash
# atlas-dev.sh — run an Atlas command against an ephemeral, per-invocation local
# Postgres (Atlas's "dev" database for normalising schema.sql and computing
# diffs) on a private socket in a temp dir, so concurrent runs cannot interfere.
# If `initdb`/`atlas` are not on PATH it re-execs itself inside
# `nix shell nixpkgs#postgresql_16 nixpkgs#atlas`.
#
# Usage: scripts/atlas-dev.sh <atlas args...>
#   scripts/atlas-dev.sh migrate diff my_change --env webhooks
#   scripts/atlas-dev.sh migrate validate --env broker
# ATLAS_DEV_URL is exported into the atlas invocation; atlas.hcl reads it as `dev`.
# Atlas runs where the `--env` database's atlas.hcl is: lib/sql for a core
# database, contrib/<name>/sql for a contrib's (scripts/db-sql-dir.sh).
set -euo pipefail

# The guard var stops an infinite re-exec.
if [ -z "${ATLAS_DEV_NIX:-}" ] && { ! command -v initdb >/dev/null 2>&1 || ! command -v atlas >/dev/null 2>&1; }; then
  export ATLAS_DEV_NIX=1
  exec nix shell nixpkgs#postgresql_16 nixpkgs#atlas -c "$0" "$@"
fi

here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
pgdata="$tmp/data"
sock="$tmp/sock"
mkdir -p "$sock"

cleanup() {
  pg_ctl -D "$pgdata" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

# A random high port avoids collisions with any local server / parallel runs.
port=$(( (RANDOM % 20000) + 40000 ))

# Keep stderr: initdb's root refusal is its only diagnostic.
initdb -D "$pgdata" -U postgres --auth=trust >/dev/null
pg_ctl -D "$pgdata" \
  -o "-k $sock -c listen_addresses=127.0.0.1 -c port=$port" \
  -l "$tmp/pg.log" start >/dev/null || { cat "$tmp/pg.log" >&2; exit 1; }

# Wait until it accepts connections.
for _ in $(seq 1 30); do
  if psql -h 127.0.0.1 -p "$port" -U postgres -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 0.5
done
createdb -h 127.0.0.1 -p "$port" -U postgres atlasdev

export ATLAS_DEV_URL="postgres://postgres@127.0.0.1:$port/atlasdev?sslmode=disable&search_path=public"

# Find the --env database's atlas.hcl; with no --env, lib/sql's.
confdir="lib/sql"
prev=""
for a in "$@"; do
  if [ "$prev" = "--env" ]; then
    case "$("$here/scripts/db-sql-dir.sh" "$a")" in
      contrib/*) confdir="$("$here/scripts/db-sql-dir.sh" "$a")" ;;
    esac
  fi
  prev="$a"
done
cd "$here/$confdir"
atlas "$@"
