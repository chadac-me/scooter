"""handoff's agent tools: spawn a conversation, search and read shared ones.

The source conversation always comes from the verified conversation token, never an
argument, and the router derives the new conversation's owner and visibility from it.
"""

from __future__ import annotations

import json
import logging

import httpx
from fastmcp import FastMCP

from scooter_broker_lib.autolink import Link, post_link
from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult

from . import HANDOFF_SOURCE
from .agent_host import AgentHost, SpawnError
from .store import HandoffStore, now_utc

logger = logging.getLogger(__name__)

mcp = FastMCP(name="handoff")

_MAX_BRIEF = 48 * 1024
_MAX_READ_CHARS = 2000
_MAX_BUNDLES = 20

# Set by the provider factory.
_store: HandoffStore | None = None
_agent_host: AgentHost | None = None
_base_url = ""


def configure(store: HandoffStore | None, agent_host: AgentHost | None, base_url: str) -> None:
    global _store, _agent_host, _base_url
    _store, _agent_host, _base_url = store, agent_host, base_url.rstrip("/")


def conversation_url(conversation_id: str) -> str:
    return f"{_base_url}/?thread={conversation_id}" if _base_url else conversation_id


@mcp.tool
async def handoff_spawn(
    brief: str, title: str = "", bundles: list[str] | None = None, model: str = "",
    ctx: ToolContext = ToolContextDep,
) -> ToolResult:
    """Hand a task to a NEW top-level conversation, with its own sandbox and its own
    place in the user's sidebar, and start it with `brief` as its first message.

    Prefer this to spawn_subagent when the work outlives this turn, needs its own
    sandbox, or the user should drive it separately. It is not a subagent: nothing
    reports back here. The new conversation has the same owner and visibility as this
    one, and none of this conversation's history or files, so `brief` must stand
    alone: the goal, what is done, what is left, repos, branches and decisions.
    `bundles` are bundle ids from POST handoff/bundles; the broker appends the
    commands that unpack them. The router caps spawns per conversation per hour.
    """
    if _store is None or _agent_host is None:
        return ToolResult.error("handoff is not configured here")
    source_id = ctx.identity.conversation_id
    if not source_id:
        return ToolResult.error("no conversation for this caller")
    bundles = bundles or []
    brief = brief.strip()
    if not brief:
        return ToolResult.error("brief is required")
    if len(brief) > _MAX_BRIEF:
        return ToolResult.error(f"brief exceeds {_MAX_BRIEF} bytes; move detail into a bundle")
    if len(bundles) > _MAX_BUNDLES:
        return ToolResult.error(f"at most {_MAX_BUNDLES} bundles per handoff")
    now = now_utc()
    for bundle_id in bundles:
        if await _store.bundle(bundle_id, now) is None:
            return ToolResult.error(f"no such bundle, or it expired: {bundle_id}")

    try:
        # Only a shared source is readable through handoff_read.
        shared = await _agent_host.conversation(source_id) is not None
        made = await _agent_host.spawn(
            source_id, prompt=_prompt(brief, source_id, bundles, shared=shared),
            title=title.strip(), model=model.strip(), source=HANDOFF_SOURCE,
        )
    except SpawnError as e:
        hint = f" A conversation was created anyway: {conversation_url(e.conversation_id)}" if e.conversation_id else ""
        return ToolResult.error(f"handoff failed: {e}.{hint}")
    except httpx.HTTPError as e:
        return ToolResult.error(f"handoff failed: router unreachable: {e}")

    new_id = made["id"]
    label = title.strip() or "Handoff"
    await post_link(_agent_host.url, source_id, Link("handoff", "conversation", conversation_url(new_id), f"Handed off: {label}"))
    await post_link(_agent_host.url, new_id, Link("handoff", "conversation", conversation_url(source_id), "Handed off from"))
    for bundle_id in bundles:
        await _store.touch_bundle(bundle_id, now)
    return ToolResult.ok(json.dumps({
        "conversation_id": new_id, "url": conversation_url(new_id), "visibility": made.get("visibility"),
    }))


def _prompt(brief: str, source_id: str, bundles: list[str], *, shared: bool) -> str:
    lines = [brief, "", "---", f"Handed off from conversation {source_id} ({conversation_url(source_id)})."]
    if shared:
        lines.append(f'Read its history with handoff_read(conversation_id="{source_id}") if the brief leaves a gap.')
    if bundles:
        lines.append("Files were handed over as bundles. Unpack each before you start:")
        lines += [f"    agent-broker handoff/bundles/{b} -o - | tar --zstd -xf - -C /workspace" for b in bundles]
    return "\n".join(lines)


@mcp.tool
async def handoff_search(query: str, limit: int = 10, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Search past SHARED conversations by what was said in them (full-text, English
    stemming; quotes, OR and -word work). Returns one hit per conversation with a
    snippet; read one with handoff_read. Private conversations and subagents are never
    indexed, and the index trails live activity by a few minutes.
    """
    if _store is None or _agent_host is None:
        return ToolResult.error("handoff is not configured here")
    if not query.strip():
        return ToolResult.error("query is required")
    limit = max(1, min(limit, 25))
    hits = await _store.search(query, limit * 2, exclude={ctx.identity.conversation_id})
    # The live list catches a newly private conversation.
    shared = {row["id"] for row in await _agent_host.shared()}
    out = [
        {
            "conversation_id": h.conversation_id, "title": h.title, "owner": h.owner,
            "last_activity_ms": h.last_activity_at, "url": conversation_url(h.conversation_id),
            "snippet": h.snippet, "score": h.score,
        }
        for h in hits if h.conversation_id in shared
    ][:limit]
    return ToolResult.ok(json.dumps(out, indent=1) if out else "No shared conversation matches.")


@mcp.tool
async def handoff_read(
    conversation_id: str, before: int = 0, limit: int = 600, ctx: ToolContext = ToolContextDep
) -> ToolResult:
    """Read a SHARED conversation's user and assistant messages, newest page first.

    Each message is clipped to 2000 characters. To page back, pass the returned
    `next_before` as `before`; it is null at the start of the conversation. `limit`
    counts history events per page (a message is several), capped at 3000.
    """
    if _agent_host is None:
        return ToolResult.error("handoff is not configured here")
    page = await _agent_host.messages(
        conversation_id, before=before if before > 0 else 2**53 - 1, limit=max(1, min(limit, 3000)),
    )
    if page is None:
        return ToolResult.error("no such shared conversation (private conversations cannot be read)")
    messages = [
        {"role": m["role"], "text": _clip(m["content"])}
        for m in page.get("messages", [])
        if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str) and m["content"].strip()
    ]
    conv = await _agent_host.conversation(conversation_id) or {}
    return ToolResult.ok(json.dumps({
        "title": conv.get("title"), "owner": conv.get("owner"), "url": conversation_url(conversation_id),
        "messages": messages, "next_before": None if page.get("done") else page.get("fromSeq"),
    }, indent=1))


def _clip(text: str) -> str:
    text = text.strip()
    return text if len(text) <= _MAX_READ_CHARS else text[:_MAX_READ_CHARS] + " …"
