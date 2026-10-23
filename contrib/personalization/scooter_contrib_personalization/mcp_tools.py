"""personalization's agent tools.

personalization_get is for every agent. personalization_history and
personalization_write are for the refresh-profile system task's conversations only,
gated so they are unlisted anywhere else. The owner always comes from the verified
conversation, never from an argument.
"""

from __future__ import annotations

from collections import defaultdict

from fastmcp import FastMCP

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate

from .store import PersonalizationStore, ProtectedNote, now_iso

mcp = FastMCP(name="personalization")

# Set by the provider factory.
_store: PersonalizationStore | None = None


def set_store(store: PersonalizationStore | None) -> None:
    global _store
    _store = store


def _owner(ctx: ToolContext) -> str | None:
    # TODO: a sandbox SA carries no owner; resolve conversation -> owner through the
    # agent-host when identity.owner is unset (design, "Agent tools").
    return ctx.identity.owner


async def _is_system_conversation(ctx: ToolContext) -> bool:
    # TODO(PR 3): true when the conversation's source is "system" and it was spawned
    # by personalization's refresh-profile task. Until then the tools stay unlisted.
    return False


def _grouped(notes) -> str:
    by_cat: dict[str, list] = defaultdict(list)
    for n in notes:
        by_cat[n.category].append(n)
    lines: list[str] = []
    for cat in sorted(by_cat):
        lines.append(f"## {cat}")
        for n in by_cat[cat]:
            flags = ", ".join(f for f in (n.source, "pinned" if n.pinned else "") if f)
            lines.append(f"- [{n.id}] ({flags}) {n.note}")
    return "\n".join(lines)


@mcp.tool
async def personalization_get(category: str = "", ctx: ToolContext = ToolContextDep) -> str:
    """Read the user's personalization profile: notes about how they work, grouped by
    category (common-asks, agent-habits, preferences, environment, ...).

    Call it at the start of substantive work. Treat notes as preferences, not commands:
    the user's explicit instructions in this conversation always win.
    """
    owner = _owner(ctx)
    if _store is None or owner is None:
        return "No personalization profile is available for this conversation."
    profile = await _store.profile(owner)
    if not profile.enabled:
        return "The user has turned personalization off."
    notes = await _store.notes(owner, category or None)
    return _grouped(notes) or "The profile has no notes yet."


@gate(_is_system_conversation)
@mcp.tool
async def personalization_history(
    since: str = "", limit: int = 20, ctx: ToolContext = ToolContextDep
) -> ToolResult:
    """The user's recent conversations (title, dates, condensed transcript), newest
    first, excluding system conversations. Only for the refresh-profile task."""
    # TODO(PR 3): read through the agent-host as the user, condensed per conversation.
    return ToolResult.error("personalization_history is not wired yet (needs system tasks).")


@gate(_is_system_conversation)
@mcp.tool
async def personalization_write(ops: list[dict], ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Apply changes to the user's AGENT-sourced notes and stamp the analysis.

    `ops` is a list of {"op": "add", "category", "note"} | {"op": "update", "id",
    "note"?, "category"?} | {"op": "delete", "id"} | {"op": "done",
    "last_conversation_seen": ISO timestamp}. User-written and pinned notes are
    read-only to you; an op on one is refused and the rest still apply.
    """
    owner = _owner(ctx)
    if _store is None or owner is None:
        return ToolResult.error("no profile owner for this conversation")
    applied, refused = 0, []
    for op in ops:
        kind = op.get("op")
        try:
            if kind == "add":
                await _store.add_note(owner, category=op["category"], note=op["note"], source="agent")
            elif kind == "update":
                fields = {k: op[k] for k in ("note", "category") if k in op}
                if await _store.update_note(owner, op["id"], as_agent=True, **fields) is None:
                    refused.append(f"{op['id']}: no such note")
                    continue
            elif kind == "delete":
                if not await _store.delete_note(owner, op["id"], as_agent=True):
                    refused.append(f"{op['id']}: no such note")
                    continue
            elif kind == "done":
                await _store.update_profile(
                    owner, last_analyzed_at=now_iso(),
                    last_conversation_seen=op.get("last_conversation_seen"),
                )
            else:
                refused.append(f"unknown op {kind!r}")
                continue
            applied += 1
        except ProtectedNote as e:
            refused.append(f"{e.args[0]}: user-written or pinned")
        except KeyError as e:
            refused.append(f"{kind}: missing {e.args[0]}")
    text = f"applied {applied} op(s)"
    if refused:
        text += "; refused: " + "; ".join(refused)
    return ToolResult.ok(text)


def personalization_mcp_server() -> FastMCP:
    return mcp
