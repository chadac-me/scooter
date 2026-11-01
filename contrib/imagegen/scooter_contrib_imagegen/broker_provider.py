"""The imagegen provider: wires the enabled backends, the chosen selector and the
usage store into one `generate_image` tool. Disabled (no routes, no tool) when no
backend is turned on.
"""

from __future__ import annotations

import logging

from fastmcp import FastMCP

from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider

from .config import ImagegenSettings
from .mcp_tools import build_generate_image_tool
from .plugins import discover_backends, discover_selectors
from .store import GenerationStore

logger = logging.getLogger(__name__)


@register_provider
def imagegen(ctx: BrokerContext) -> Provider:
    settings = ImagegenSettings()
    mcp = FastMCP(name="imagegen")
    configured = settings.enabled_backends()
    if not configured:
        return Provider(name="imagegen", transports=[McpTools(server=mcp)], enabled=False)

    backends = discover_backends()
    active = {}
    for name, cfg in configured.items():
        if name not in backends:
            logger.warning(
                "contribs.imagegen.backends.%s is enabled but no scooter_imagegen.backends "
                "entry point named %r was found (missing dependency?) — dropping it",
                name,
                name,
            )
            continue
        active[name] = cfg
    if not active:
        return Provider(name="imagegen", transports=[McpTools(server=mcp)], enabled=False)

    selectors = discover_selectors()
    selector = selectors.get(settings.imagegen_selector)
    if selector is None:
        logger.warning(
            "contribs.imagegen.selector=%r has no scooter_imagegen.selectors entry point; "
            "falling back to 'priority'",
            settings.imagegen_selector,
        )
        selector = selectors.get("priority")
    if selector is None:
        # The in-tree "priority" entry point failed to load, which is a packaging bug,
        # not a deployment misconfiguration — surface it loudly rather than disable silently.
        raise RuntimeError("no selector available: even the built-in 'priority' failed to load")

    store = GenerationStore(ctx.contrib_store_config("imagegen"))
    build_generate_image_tool(
        mcp,
        backends=backends,
        backend_configs=active,
        selector=selector,
        selector_name=settings.imagegen_selector,
        store=store,
        daily_limit=settings.imagegen_daily_limit,
        agent_host_url=settings.agent_host_url,
    )
    return Provider(name="imagegen", transports=[McpTools(server=mcp)], enabled=True)
