"""Kagi broker provider: tools only, no proxy route, gated on the key."""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider

from .config import KagiSettings
from .mcp_tools import UPSTREAM, kagi_mcp_server

PROVIDER_NAME = "kagi"


@register_provider
def kagi() -> Provider:
    settings = KagiSettings()
    key = (settings.kagi_api_key or "").strip()
    return Provider(
        name=PROVIDER_NAME,
        # Kagi's scheme is `Authorization: Bot <token>`, so the prefix is part of the value.
        credential=StaticTokenSource(
            token=f"Bot {key}" if key else "",
            kind="header",
            header_name="Authorization",
        ),
        transports=[McpTools(server=kagi_mcp_server(), upstream=UPSTREAM)],
        enabled=bool(key),
    )
