"""Echo broker provider: the broker half of the reference contrib.

Registered into the broker via the ``agent_broker.providers`` entry point and
build-depending only on ``scooter_broker_lib``. It mounts a ``/echo/ping``
transport that authenticates the caller like every real transport and echoes the
validated identity back, demonstrating a custom Transport, a Provider factory and
entry-point discovery without touching the broker core.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter, Depends

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import AuthDependency, Identity, Provider, Transport
from scooter_broker_lib.user import user_identity

from .approvals import EchoApprovals
from .mcp_tools import echo_mcp_server

PROVIDER_NAME = "echo"


@dataclass
class EchoTransport(Transport):
    """Minimal example transport: one authenticated route that echoes the identity, mounted under ``/{provider.name}``."""

    name: str = "echo"

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()

        @router.get("/ping")
        async def ping(identity: Identity = Depends(authed)) -> dict[str, str]:
            return {
                "provider": provider.name,
                "conversation_id": identity.conversation_id,
                "pong": "echo",
            }

        user = user_identity(authed)

        @router.get("/user/whoami")
        async def whoami(user_id: str = Depends(user)) -> dict[str, str]:
            """The settings tab's round-trip: the user the /contrib-api relay named."""
            return {"provider": provider.name, "user": user_id}

        return router


@register_provider
def echo() -> Provider:
    """Build the echo provider, always enabled because it is only installed in test and example images."""
    return Provider(
        name=PROVIDER_NAME,
        # The identity echo, a human-approval flow built only from the public seam, and the contrib's agent tools; httpbin is a stand-in upstream nothing in the suite calls.
        transports=[
            EchoTransport(),
            EchoApprovals(),
            McpTools(server=echo_mcp_server(), upstream="https://httpbin.org"),
        ],
        credential=None,  # a diagnostic transport delivers no secret
        enabled=True,
    )
