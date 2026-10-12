"""Resolve an invoking external user to their Scooter user by email, so a webhook-spawned conversation gets a real owner.

The external user id becomes an email via the provider's registered resolver, then a
Scooter user id via the agent-host's `/users/by-email` lookup; any miss yields None
and the conversation stays unowned.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from scooter_lib.logging_config import format_error, pseudonym

from .agent_host_client import user_id_for_email

logger = logging.getLogger(__name__)
_C = {"component": "identity"}

EmailResolver = Callable[[str], Awaitable[str | None]]

_resolvers: dict[str, EmailResolver] = {}


def register_email_resolver(provider: str) -> Callable[[EmailResolver], EmailResolver]:
    """Register an ``async def (external_id) -> str | None`` email lookup for one provider, replacing any earlier one."""

    def decorate(fn: EmailResolver) -> EmailResolver:
        _resolvers[provider] = fn
        return fn

    return decorate


def registered_providers() -> list[str]:
    """Which providers can resolve an owner, for diagnostics."""
    return sorted(_resolvers)


async def get_user_email(provider: str, external_id: str) -> str | None:
    """The email for an invoking external user, or None if no resolver is registered or it cannot answer."""
    resolver = _resolvers.get(provider)
    if resolver is None or not external_id:
        return None
    try:
        return await resolver(external_id)
    except Exception as e:
        # A raise here would take down a webhook delivery over a best-effort lookup.
        logger.warning(
            "email resolver failed",
            extra={**_C, "provider": provider, "external_user": pseudonym(external_id), "error": format_error(e)},
        )
        return None


async def resolve_owner(provider: str, external_id: str) -> str | None:
    """Map an invoking external user to their Scooter user id by email, or None on any miss."""
    if not external_id:
        return None
    email = await get_user_email(provider, external_id)
    if not email:
        return None
    owner = await user_id_for_email(email)
    if owner:
        logger.info(
            "resolved external user to scooter user",
            extra={**_C, "provider": provider, "user_id": pseudonym(owner)},
        )
    return owner
