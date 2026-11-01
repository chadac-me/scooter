"""The commits provider: the identity store, its routes and tools, and the lookup commit_identity asks first."""

from __future__ import annotations

from scooter_broker_lib import commit_identity
from scooter_broker_lib.commit_identity import Person
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Provider

from . import mcp_tools
from .config import CommitsSettings
from .host import HostCards
from .store import CommitIdentityStore
from .transport import Commits


@register_provider
def commits(ctx: BrokerContext) -> Provider:
    transport = Commits()
    tools = McpTools(server=mcp_tools.commits_mcp_server())
    settings = CommitsSettings()
    if not settings.commits_enabled or ctx.owners is None:
        return Provider(name="commits", transports=[transport, tools], enabled=False)

    store = CommitIdentityStore(ctx.contrib_store_config("commits"))
    cards = HostCards(settings.agent_host_url)
    transport.store, transport.cards = store, cards
    mcp_tools.configure(store, ctx.owners, cards)

    async def chosen(user: str) -> Person | None:
        found = await store.get(user)
        return found.person if found else None

    commit_identity.provide_chosen(chosen)
    return Provider(name="commits", transports=[transport, tools], enabled=True)
