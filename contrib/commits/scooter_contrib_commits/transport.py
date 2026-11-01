"""commits' HTTP routes, mounted under /commits/*.

    GET    /user/identity                     the caller's commit identity, or {"identity": null}
    PUT    /user/identity                     {name, email}: set or replace it
    DELETE /user/identity                     clear it, so commits fall back to the forge account
    GET    /proposals/pending                 ?conversation_id=: pending proposals' approval cards
    POST   /proposals/{id}/can-approve        {approver}: whether this person may answer
    POST   /proposals/{id}/approve            {approver}: write it, withdraw the others' cards
    POST   /proposals/{id}/deny               {approver}

/user/* is reached only through the /contrib-api relay, which names the user
(scooter_broker_lib.user.user_identity). /proposals/* is the agent-host's
approval relay (scooter.approvals.commits), so it takes approver callers only,
and only the proposal's own user may answer. Agents propose through mcp_tools.py.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import APIRouter, Body, Depends, HTTPException

from scooter_broker_lib.types import AuthDependency, Identity, Provider
from scooter_broker_lib.user import user_identity

from .host import Cards, card
from .store import CommitIdentityStore, InvalidIdentity, NotYours, Proposal, Refused, validated


class _NoCards:
    async def raise_(self, p: Proposal) -> None:
        return None

    async def withdraw(self, p: Proposal) -> None:
        return None


def _approver(body: dict) -> str:
    """The answering user's id, as the agent-host sends it."""
    a = body.get("approver")
    who = a.get("id") if isinstance(a, dict) else a
    if not isinstance(who, str) or not who:
        raise HTTPException(status_code=400, detail="approver required")
    return who


@dataclass
class Commits:
    store: CommitIdentityStore | None = None
    cards: Cards = field(default_factory=_NoCards)
    name: str = "commits"

    def _ready(self) -> CommitIdentityStore:
        if self.store is None:
            raise HTTPException(status_code=503, detail="commits is not configured")
        return self.store

    async def withdraw(self, superseded: list[Proposal]) -> None:
        for p in superseded:
            await self.cards.withdraw(p)

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()
        user = user_identity(authed)

        async def approver_caller(identity: Identity = Depends(authed)) -> Identity:
            if not identity.is_approver:
                raise HTTPException(status_code=403, detail="not an approver")
            return identity

        @router.get("/user/identity")
        async def get_identity(user_id: str = Depends(user)) -> dict:
            chosen = await self._ready().get(user_id)
            return {"identity": chosen.payload() if chosen else None}

        @router.put("/user/identity")
        async def set_identity(body: dict = Body(...), user_id: str = Depends(user)) -> dict:
            try:
                person = validated(body.get("name", ""), body.get("email", ""))
            except InvalidIdentity as e:
                raise HTTPException(status_code=400, detail=str(e)) from None
            chosen, superseded = await self._ready().set(user_id, person)
            await self.withdraw(superseded)
            return {"identity": chosen.payload()}

        @router.delete("/user/identity")
        async def clear_identity(user_id: str = Depends(user)) -> dict:
            await self._ready().clear(user_id)
            return {"identity": None}

        @router.get("/proposals/pending", dependencies=[Depends(approver_caller)])
        async def pending(conversation_id: str = "") -> dict:
            if not conversation_id:
                raise HTTPException(status_code=400, detail="conversation_id required")
            return {"requests": [card(p) for p in await self._ready().pending(conversation_id=conversation_id)]}

        @router.post("/proposals/{proposal_id}/can-approve", dependencies=[Depends(approver_caller)])
        async def can_approve(proposal_id: str, body: dict = Body(default={})) -> dict:
            p = await self._ready().proposal(proposal_id)
            return {"can_approve": p is not None and p.status == "pending" and p.user_id == _approver(body)}

        @router.post("/proposals/{proposal_id}/approve", dependencies=[Depends(approver_caller)])
        async def approve(proposal_id: str, body: dict = Body(default={})) -> dict:
            try:
                decision = await self._ready().approve(proposal_id, _approver(body))
            except NotYours as e:
                raise HTTPException(status_code=403, detail={"errors": [str(e)]}) from None
            except Refused as e:
                return {"identity": None, "refused": str(e)}
            await self.withdraw(decision.superseded)
            return {"identity": decision.identity.payload(), "superseded": [p.id for p in decision.superseded]}

        @router.post("/proposals/{proposal_id}/deny", dependencies=[Depends(approver_caller)])
        async def deny(proposal_id: str, body: dict = Body(default={})) -> dict:
            try:
                await self._ready().deny(proposal_id, _approver(body))
            except NotYours as e:
                raise HTTPException(status_code=403, detail={"errors": [str(e)]}) from None
            except Refused as e:
                return {"refused": str(e)}
            return {"denied": proposal_id}

        return router
