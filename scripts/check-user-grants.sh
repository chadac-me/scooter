#!/usr/bin/env bash
# Only the audited paths may mint a UserGrant (scooter_broker_lib/user_secrets.py).
set -euo pipefail

cd "$(dirname "$0")/.."

LIB=lib/py/scooter-broker-lib/scooter_broker_lib
ALLOWED="$LIB/user_secrets.py $LIB/owner.py $LIB/user.py"

bad=$(git ls-files '*.py' | grep -v '/tests/' | grep -vxF -f <(tr ' ' '\n' <<<"$ALLOWED") \
  | xargs grep -lE '\b_mint\b|\b_MINTED\b' || true)
if [ -n "$bad" ]; then
  cat >&2 <<MSG
❌ These modules mint a UserGrant, which opens a user's personal secrets:

$bad

Only $ALLOWED may. Take a grant from OwnerResolver.grant (a private
conversation's owner) or user.user_grant (the user's Settings session) instead.
MSG
  exit 1
fi
echo "✅ UserGrant minted only by the audited paths"
