"""The agent-host's approval cards for proposals: raise one, or withdraw one nobody needs to answer.

Both are best effort. A card that failed to raise comes back when the host
re-lists /commits/proposals/pending on revive; a card that failed to withdraw
changes nothing when clicked, since its proposal is no longer pending.
"""

from __future__ import annotations

import logging
from typing import Protocol

import httpx

from scooter_broker_lib.autolink import router_headers
from scooter_lib.logging_config import format_error

from .store import Proposal

logger = logging.getLogger(__name__)

CONTRIB = "commits"
KIND = "commits.identity"


def card(p: Proposal) -> dict:
    """The approval request the host raises; ui/ProposalCard.tsx draws `data`."""
    return {
        "request_id": p.id,
        "message": f"The agent proposes your commit identity: {p.person.ident()}",
        "kind": KIND,
        "data": {"name": p.person.name, "email": p.person.email},
    }


class Cards(Protocol):
    async def raise_(self, p: Proposal) -> None: ...
    async def withdraw(self, p: Proposal) -> None: ...


class HostCards:
    def __init__(self, agent_host_url: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._base = agent_host_url.rstrip("/")
        self._transport = transport

    async def raise_(self, p: Proposal) -> None:
        await self._call("POST", f"/conversations/{p.conversation_id}/approvals/{CONTRIB}", p, json=card(p))

    async def withdraw(self, p: Proposal) -> None:
        await self._call("DELETE", f"/conversations/{p.conversation_id}/approvals/{CONTRIB}/{p.id}", p)

    async def _call(self, method: str, path: str, p: Proposal, **kw) -> None:
        if not self._base:
            return
        extra = {"conversation_id": p.conversation_id, "proposal_id": p.id, "method": method}
        try:
            async with httpx.AsyncClient(base_url=self._base, timeout=10, transport=self._transport) as c:
                r = await c.request(method, path, headers=router_headers(), **kw)
        except httpx.HTTPError as e:
            logger.warning("approval card call failed", extra={**extra, "error": format_error(e)})
            return
        if r.status_code >= 300:
            logger.warning("approval card call refused", extra={**extra, "status": r.status_code})
