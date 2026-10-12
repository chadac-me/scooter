#!/usr/bin/env bash
# git-credential-broker: a git credential helper that fetches short-lived HTTPS
# credentials from the broker, authenticated with the pod's projected SA token.
# Wired via `git config --global credential.helper broker`; git invokes it as
# `git-credential-broker get` with key=value lines on stdin and reads
# protocol/host/username/password back on stdout. Env: BROKER_URL,
# BROKER_TOKEN_PATH, and GIT_BROKER_HOST_MAP (host=provider pairs).

set -euo pipefail

# Only "get" vends; store/erase are no-ops.
op="${1:-}"
[ "$op" = "get" ] || exit 0

# Parse the credential description git sends on stdin.
host=""
protocol=""
while IFS='=' read -r key value; do
    [ -z "$key" ] && break
    case "$key" in
        host) host="$value" ;;
        protocol) protocol="$value" ;;
    esac
done

# The broker vends HTTPS creds only.
[ "$protocol" = "https" ] || exit 0
[ -n "$host" ] || exit 0

BROKER_URL="${BROKER_URL:-}"
TOKEN_PATH="${BROKER_TOKEN_PATH:-/var/run/secrets/broker/token}"
# Defer to other helpers if the broker is not configured in this pod.
[ -n "$BROKER_URL" ] || exit 0
[ -r "$TOKEN_PATH" ] || exit 0

# Map the git host to a broker provider; GIT_BROKER_HOST_MAP overrides the default map.
provider=""
default_map="github.com=github,gitlab.com=gitlab"
IFS=',' read -ra _pairs <<< "${GIT_BROKER_HOST_MAP:-$default_map}"
for pair in "${_pairs[@]}"; do
    h="${pair%%=*}"; p="${pair#*=}"
    if [ "$h" = "$host" ]; then provider="$p"; break; fi
done
# An unknown host falls through to the next helper.
[ -n "$provider" ] || exit 0

token="$(cat "$TOKEN_PATH")"
resp="$(curl -sf -H "Authorization: Bearer ${token}" \
    "${BROKER_URL%/}/${provider}/git-credentials" 2>/dev/null)" || exit 0

username="$(printf '%s' "$resp" | jq -r '.username // empty' 2>/dev/null)" || exit 0
password="$(printf '%s' "$resp" | jq -r '.password // empty' 2>/dev/null)" || exit 0
[ -n "$username" ] && [ -n "$password" ] || exit 0

# Echo back the host/protocol git asked for.
printf 'protocol=%s\n' "$protocol"
printf 'host=%s\n' "$host"
printf 'username=%s\n' "$username"
printf 'password=%s\n' "$password"
