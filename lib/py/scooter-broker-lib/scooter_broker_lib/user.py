"""The signed-in user behind a contrib settings tab.

A tab declared with ``api = true`` reaches its contrib's broker routes under
``/<contrib>/user/*`` through the agent-host's ``/contrib-api`` relay. The relay calls as
the agent-host's service account and names the user in ``X-Scooter-User``; the core
trusts that header only from an account in ``USER_RELAY_SERVICE_ACCOUNTS`` and exposes it
as ``Identity.relayed_user``. A sandbox, or any other caller, gets ``None`` there.

A transport depends on the user id and scopes every query to it::

    def routes(self, provider, authed):
        router = APIRouter()
        user = user_identity(authed)

        @router.get("/user/profile")
        async def profile(user_id: str = Depends(user)) -> dict:
            ...
"""

from __future__ import annotations

from typing import Awaitable, Callable

from fastapi import Depends, HTTPException

from .types import AuthDependency, Identity
from .user_secrets import UserGrant, _mint


def user_identity(authed: AuthDependency) -> Callable[..., Awaitable[str]]:
    """A FastAPI dependency returning the relayed user id, or 403 for any caller that is not the relay."""

    async def _user(identity: Identity = Depends(authed)) -> str:
        if not identity.relayed_user:
            raise HTTPException(
                status_code=403,
                detail="user routes are reachable only through the /contrib-api relay",
            )
        return identity.relayed_user

    return _user


def user_grant(authed: AuthDependency) -> Callable[..., Awaitable[UserGrant]]:
    """Like `user_identity`, but a grant to the signed-in user's own secrets."""
    user = user_identity(authed)

    async def _grant(user_id: str = Depends(user)) -> UserGrant:
        return _mint(user_id, "settings-session")

    return _grant
