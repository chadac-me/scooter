"""The personalization provider: the profile store, its routes and the agent tools.

Off unless `personalization_enabled`; the registry then drops the routes and tools,
so no agent is offered a profile that is not there.
"""

from __future__ import annotations

from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider

from . import mcp_tools
from .config import settings
from .store import PersonalizationStore
from .transport import Personalization


@register_provider
def personalization(ctx: BrokerContext) -> Provider:
    transport = Personalization()
    tools = McpTools(server=mcp_tools.personalization_mcp_server())

    if not settings.personalization_enabled:
        return Provider(name="personalization", transports=[transport, tools], enabled=False)

    store = PersonalizationStore(ctx.contrib_store_config("personalization"))
    transport.store = store
    mcp_tools.set_store(store)
    # transport.user defaults to the /contrib-api relay identity.
    # TODO(PR 3): transport.system and transport.activity, once the scheduler identity
    # and an agent-host activity query exist.
    return Provider(name="personalization", transports=[transport, tools], enabled=True)
