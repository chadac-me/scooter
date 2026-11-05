"""The handoff provider: the bundle store, the search index, their routes and the agent tools.

Off unless `handoff_enabled`; the registry then drops the routes and tools, so no agent
is offered a handoff that is not there.
"""

from __future__ import annotations

from datetime import timedelta

from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider

from . import mcp_tools
from .agent_host import AgentHost
from .config import settings
from .store import HandoffStore
from .transport import Handoff


@register_provider
def handoff(ctx: BrokerContext) -> Provider:
    transport = Handoff(max_bundle_bytes=settings.handoff_max_bundle_bytes, quota_bytes=settings.handoff_sandbox_quota_bytes)
    tools = McpTools(server=mcp_tools.mcp)

    if not settings.handoff_enabled:
        return Provider(name="handoff", transports=[transport, tools], enabled=False)

    store = HandoffStore(ctx.contrib_store_config("handoff"), ttl=timedelta(days=settings.handoff_bundle_ttl_days))
    agent_host = AgentHost(settings.agent_host_url) if settings.agent_host_url else None
    transport.store, transport.agent_host = store, agent_host
    mcp_tools.configure(store, agent_host, settings.handoff_public_base_url)
    return Provider(name="handoff", transports=[transport, tools], enabled=True)
