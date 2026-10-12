"""scooter_broker_lib: the broker extension surface.

Everything a broker provider composes (types, registry, autolink, sources,
transports, authz, context, store, mcp, search, links, refs), so a contrib can
build-depend on it directly. It depends only on `scooter_lib` and imports nothing
from the broker app or from `scooter_webhooks_lib`. What belongs here is what a
second integration could plausibly compose; anything only one integration needs
stays with that provider.
"""

from .types import (
    AuthDependency,
    Credential,
    CredentialSource,
    Identity,
    Provider,
    Transport,
)

__all__ = [
    "AuthDependency",
    "Credential",
    "CredentialSource",
    "Identity",
    "Provider",
    "Transport",
]
