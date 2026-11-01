"""commits' agent tools, listed only in the owner's private conversation.

The user is always the conversation's acting user, never an argument. An agent
can read the identity and fill in an empty one, but never change one.
"""

from __future__ import annotations

from fastmcp import FastMCP

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate
from scooter_broker_lib.owner import OwnerResolver

from .store import CommitIdentityStore, InvalidIdentity, validated

mcp = FastMCP(name="commits")

# Set by the provider factory.
_store: CommitIdentityStore | None = None
_owners: OwnerResolver | None = None


def configure(store: CommitIdentityStore | None, owners: OwnerResolver | None) -> None:
    global _store, _owners
    _store, _owners = store, owners


async def _acting(ctx: ToolContext) -> str | None:
    if _store is None or _owners is None:
        return None
    return await _owners.acting_user(ctx.identity)


async def _is_private(ctx: ToolContext) -> bool:
    return await _acting(ctx) is not None


_SETTINGS = "Settings → Commit identity"


@gate(_is_private)
@mcp.tool
async def commit_identity_get(ctx: ToolContext = ToolContextDep) -> ToolResult:
    """The name and email the user's commits carry, and whether the user or an agent set it.

    If none is set, work out the identity the user usually commits under and pass it
    to commit_identity_propose (see the commit-identity skill).
    """
    user = await _acting(ctx)
    if user is None or _store is None:
        return ToolResult.error("no commit identity outside the owner's private conversation")
    chosen = await _store.get(user)
    if chosen is None:
        return ToolResult.ok("No commit identity is set.")
    return ToolResult.ok(f"{chosen.person.ident()} (set by {chosen.set_by})")


@gate(_is_private)
@mcp.tool
async def commit_identity_propose(name: str, email: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Set the user's commit identity, only if none is set yet. It cannot change one.

    Tell the user what you set and that they can change it at Settings → Commit identity.
    """
    user = await _acting(ctx)
    if user is None or _store is None:
        return ToolResult.error("no commit identity outside the owner's private conversation")
    try:
        person = validated(name, email)
    except InvalidIdentity as e:
        return ToolResult.error(str(e))
    if await _store.propose(user, person) is None:
        current = await _store.get(user)
        held = current.person.ident() if current else "one"
        return ToolResult.error(f"refused: {held} is already set; only the user can change it at {_SETTINGS}")
    return ToolResult.ok(f"Commits now carry {person.ident()}; the user can change it at {_SETTINGS}.")


def commits_mcp_server() -> FastMCP:
    return mcp
