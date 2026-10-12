"""DuckDuckGo broker provider: agent tools, no proxy route, and no credential.

`enabled` gates on the explicit `DUCKDUCKGO_ENABLED` flag, since there is no key
whose absence could mean off, and it defaults off so building this contrib does not
make a deployment start scraping DuckDuckGo.
"""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider

from .config import DuckduckgoSettings
from .mcp_tools import UPSTREAM, duckduckgo_mcp_server

PROVIDER_NAME = "duckduckgo"


@register_provider
def duckduckgo() -> Provider:
    # Read at build time, like every provider factory.
    settings = DuckduckgoSettings()
    return Provider(
        name=PROVIDER_NAME,
        # No credential, so the request goes out as written; no raw proxy, which would bypass the parsing that tells a bot-check page from an empty web.
        transports=[McpTools(server=duckduckgo_mcp_server(), upstream=UPSTREAM)],
        enabled=settings.duckduckgo_enabled,
    )
