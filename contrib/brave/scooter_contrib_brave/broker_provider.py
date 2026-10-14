"""Brave broker provider: a key-bearing provider with tools and no proxy route.

It ships only ``McpTools``, since a raw ``/brave/*`` route would let the agent spend
the search quota on arbitrary paths; ``enabled`` is gated on the key, so without one
the tool is absent from the agent's list.
"""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider

from .config import BraveSettings
from .mcp_tools import UPSTREAM, brave_mcp_server

PROVIDER_NAME = "brave"


@register_provider
def brave() -> Provider:
    # Read at build time, like every provider factory.
    settings = BraveSettings()
    key = (settings.brave_search_api_key or "").strip()
    return Provider(
        name=PROVIDER_NAME,
        # A header rather than a query param keeps the key out of access logs.
        credential=StaticTokenSource(
            token=key, kind="header", header_name="X-Subscription-Token"
        ),
        transports=[McpTools(server=brave_mcp_server(), upstream=UPSTREAM)],
        enabled=bool(key),
    )
