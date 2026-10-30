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
# A random high port avoids collisions with any local server / parallel runs.
port=$(( (RANDOM % 20000) + 40000 ))
pg="$("$here/scripts/pg-ephemeral.sh" start "$port")"
trap '"$here/scripts/pg-ephemeral.sh" stop "$pg"' EXIT
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
