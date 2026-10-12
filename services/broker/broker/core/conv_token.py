"""Conversation-token verification, the broker half of the primitive the agent-host mints
in services/agent-host/src/auth/convToken.ts.

A control-plane SA token says a trusted component is calling and the conversation token
says which conversation it acts for; both are required, which is what makes the long
conversation-token TTL safe. Tokens are HS256 verified with a fixed algorithm list, which
is what defeats alg confusion.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# Must match services/agent-host/src/auth/convToken.ts, pinned by tests/fixtures/conv-token.json.
CONV_TOKEN_AUDIENCE = "scooter-mcp"
CONV_TOKEN_ISSUER = "scooter-agent-host"

# The header carrying the conversation token, separate from the SA token in `Authorization`.
CONV_TOKEN_HEADER = "x-scooter-conversation"


@dataclass(frozen=True)
class ConvToken:
    """The verified claims the broker uses."""

    conversation_id: str
    owner: str | None = None


class ConvTokenError(Exception):
    """Verification failed, with a message meant for the broker's log rather than the caller."""


def verify_conv_token(token: str, secret: str, now: int | None = None) -> ConvToken:
    """Verify a conversation token against an injectable clock `now` (seconds since epoch) and return its claims, raising ConvTokenError for every failure including an absent secret, which fails closed."""
    if not secret:
        raise ConvTokenError("no conversation-token secret configured")
    if not token:
        raise ConvTokenError("no conversation token presented")

    # Imported here to keep `pyjwt` off the import path of every other broker module.
    import jwt

    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            audience=CONV_TOKEN_AUDIENCE,
            issuer=CONV_TOKEN_ISSUER,
            # `require` keeps the presence check on exp while expiry is verified below.
            options={
                "require": ["exp", "iat", "sub", "aud", "iss"],
                "verify_exp": False,
            },
        )
    except jwt.InvalidTokenError as exc:
        raise ConvTokenError(f"invalid conversation token: {exc}") from exc

    # Expiry is checked here, not by pyjwt, so a frozen test vector can be verified against
    # an injected clock; `<=` kills a token on its exp second, as in the agent-host.
    import time

    exp = claims.get("exp")
    if not isinstance(exp, (int, float)):
        raise ConvTokenError("conversation token has a non-numeric exp")
    if exp <= (now if now is not None else int(time.time())):
        raise ConvTokenError("conversation token has expired")

    conversation_id = claims.get("sub") or ""
    if not isinstance(conversation_id, str) or not conversation_id:
        raise ConvTokenError("conversation token carries no conversation")

    owner = claims.get("owner")
    return ConvToken(
        conversation_id=conversation_id,
        owner=owner if isinstance(owner, str) and owner else None,
    )
