"""mcp-tools transport: a provider's agent tools, served by the broker's /mcp.

Mounts no routes. An MCP tool is a credential delivery mechanism like `HttpProxy`
(the broker injects the credential upstream and the agent never holds it), which is
why it is a transport rather than a new field on `Provider`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from fastapi import APIRouter

from ..types import AuthDependency, Provider, Transport

if TYPE_CHECKING:
    from fastmcp import FastMCP


def _empty_server() -> "FastMCP":
    from fastmcp import FastMCP

    return FastMCP(name="empty")


@dataclass
class McpTools(Transport):
    """Carry a provider's agent tools as a `FastMCP` server, which the broker mounts namespace-less."""

    server: "FastMCP" = field(default_factory=_empty_server)
    # The API base a tool's `ctx.upstream` calls, declared here because a provider may ship tools without a proxy route.
    upstream: str = ""
    name: str = "mcp-tools"

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        """Nothing to mount; the tools are served by the broker's /mcp endpoint, which authenticates differently."""
        return APIRouter()

    @property
    def mcp_server(self) -> "FastMCP":
        """The server the broker mounts, discovered by `hasattr`."""
        return self.server
