"""Reads conversations from the agent-host, which owns them.

The broker reaches it at the core AGENT_HOST_URL (the router in a multi-replica
deployment) with the router token, and with no user header, so the list is fleet-wide.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx
from scooter_broker_lib.autolink import router_headers

from . import REFRESH_TITLE

logger = logging.getLogger(__name__)

# The newest page of a conversation; older turns matter less to a profile.
_TRANSCRIPT_EVENTS = 1500
_MESSAGE_CHARS = 1500


def ms_to_iso(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def is_refresh_run(conv: dict[str, Any]) -> bool:
    """A conversation this contrib spawned, which no analysis should read or count."""
    return conv.get("title") == REFRESH_TITLE


@dataclass
class AgentHost:
    url: str
    timeout: float = 15.0
    # For tests (httpx.MockTransport).
    transport: httpx.AsyncBaseTransport | None = None

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self.url.rstrip("/"), timeout=self.timeout, headers=router_headers(), transport=self.transport)

    async def conversation(self, conversation_id: str) -> dict[str, Any] | None:
        """One conversation's view (owner, title, ...), None when unknown."""
        async with self._client() as c:
            r = await c.get(f"/conversations/{conversation_id}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    async def conversations(self) -> list[dict[str, Any]]:
        async with self._client() as c:
            r = await c.get("/conversations", params={"scope": "all"})
        r.raise_for_status()
        body = r.json()
        return body if isinstance(body, list) else body.get("conversations", [])

    async def latest_activity(self) -> dict[str, str]:
        """owner -> their newest non-refresh conversation's last activity (ISO)."""
        newest: dict[str, int] = {}
        for conv in await self.conversations():
            owner, at = conv.get("owner"), conv.get("lastActivityAt")
            if not owner or not isinstance(at, (int, float)) or is_refresh_run(conv) or conv.get("parentId"):
                continue
            newest[owner] = max(newest.get(owner, 0), int(at))
        return {o: ms_to_iso(at) for o, at in newest.items()}

    async def history(self, owner: str, *, since: str | None, limit: int) -> list[dict[str, Any]]:
        """The owner's top-level conversations active after `since`, newest first, each condensed."""
        convs = [
            c for c in await self.conversations()
            if c.get("owner") == owner and not is_refresh_run(c) and not c.get("parentId")
            and isinstance(c.get("lastActivityAt"), (int, float))
            and (since is None or ms_to_iso(c["lastActivityAt"]) > since)
        ]
        convs.sort(key=lambda c: c["lastActivityAt"], reverse=True)
        out = []
        for conv in convs[:limit]:
            out.append({
                "id": conv.get("id"),
                "title": conv.get("title") or "",
                "created": ms_to_iso(conv.get("createdAt") or conv["lastActivityAt"]),
                "last_activity": ms_to_iso(conv["lastActivityAt"]),
                "messages": await self._transcript(conv["id"]),
            })
        return out

    async def _transcript(self, conversation_id: str) -> list[dict[str, str]]:
        # The page before an unreachably high seq is the conversation's newest window.
        try:
            async with self._client() as c:
                r = await c.get(
                    f"/conversations/{conversation_id}/messages",
                    params={"before": 2**53 - 1, "limit": _TRANSCRIPT_EVENTS},
                )
            r.raise_for_status()
        except httpx.HTTPError as e:
            logger.warning("transcript read failed", extra={"conversation_id": conversation_id, "error": str(e)})
            return []
        return [
            {"role": m["role"], "text": _clip(m.get("content") or "")}
            for m in r.json().get("messages", [])
            if m.get("role") in ("user", "assistant") and (m.get("content") or "").strip()
        ]


def _clip(text: str) -> str:
    text = text.strip()
    return text if len(text) <= _MESSAGE_CHARS else text[:_MESSAGE_CHARS] + " …"
