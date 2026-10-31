"""A credential source that acts as the conversation's owner when it may, else as the deployment."""

from __future__ import annotations

import logging
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Awaitable, Callable

from scooter_lib.logging_config import format_error

from ..owner import OwnerResolver
from ..types import Credential, CredentialSource, Identity
from ..user_secrets import UserGrant

if TYPE_CHECKING:
    from ..forge.policy import ForgeRequest

logger = logging.getLogger(__name__)

# The user's own credential, None when they have linked none (or it can no longer be used).
UserCredentialLookup = Callable[[UserGrant], Awaitable["Credential | None"]]


@dataclass
class UserFirstSource:
    """The owner's credential in their private conversation, the `fallback` everywhere else."""

    resolver: OwnerResolver
    user_credential: UserCredentialLookup
    fallback: CredentialSource

    async def get(self, identity: Identity, request: "ForgeRequest | None" = None) -> Credential:
        grant = await self.resolver.grant(identity)
        if grant is not None:
            try:
                cred = await self.user_credential(grant)
            except Exception as e:  # noqa: BLE001 - a broken user row must not take the forge down
                logger.warning(
                    "user credential lookup failed; using the deployment credential",
                    extra={"conversation_id": identity.conversation_id, "error": format_error(e)},
                )
                cred = None
            if cred is not None:
                return replace(cred, meta={**cred.meta, "acting_as": grant.user})
        # The request picks the fallback's installation when it serves several owners.
        return await self.fallback.get(identity, request)

