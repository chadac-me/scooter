"""The authorization contract a provider is authorized against, not an implementation.

The protocol a provider is typed against plus the allow-all stand-in used when FGA
is unconfigured; the OpenFGA implementation stays in the broker app, which hands
the built authorizer to each provider through `BrokerContext`. A contrib can only
receive an authorizer, never build one, or the gate would be advisory.
"""

from __future__ import annotations

from typing import Protocol


class Authorizer(Protocol):
    async def check(self, *, user: str, relation: str, obj: str) -> bool:
        """True if `user` has `relation` to `obj`."""
        ...

    async def grant(self, *, user: str, relation: str, obj: str) -> None:
        """Record a relationship tuple; a provider seeds its own tuples because it owns its object namespace."""
        ...


class NoopAuthorizer:
    """The allow-everything stand-in for an unconfigured FGA; grant() is a no-op."""

    async def check(self, *, user: str, relation: str, obj: str) -> bool:
        return True

    async def grant(self, *, user: str, relation: str, obj: str) -> None:
        return None


def user_object(user: str) -> str:
    """The OpenFGA user id for a human, shared by every provider's tuples."""
    return f"user:{user}"
