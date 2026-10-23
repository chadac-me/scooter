"""personalization's HTTP routes, mounted under /personalization/*.

    GET    /user/profile            the caller's profile (enabled, last analysed, last run)
    PATCH  /user/profile            {enabled}
    GET    /user/notes              the caller's notes (?category=)
    POST   /user/notes              {category, note, pinned?}: a user note
    PATCH  /user/notes/{id}         {note?, category?, pinned?}
    DELETE /user/notes/{id}
    DELETE /user/notes              delete all of the caller's notes
    POST   /user/refresh            "Refresh now"
    GET    /system/eligible         owners due for a refresh (?interval=&limit=)
    POST   /system/spawned          {owner, conversation_id}: clears the request

The /user/* routes are reached only through the /contrib-api relay, which names the
user (scooter_broker_lib.user.user_identity); every query is scoped to that user.
/system/* is only for the scheduler's service account (PR 3); until that caller
exists its default dependency answers 501.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from scooter_broker_lib.types import AuthDependency, Provider, Transport
from scooter_broker_lib.user import user_identity

from .store import PersonalizationStore, now_iso

_MAX_NOTE_BYTES = 2 * 1024
_CATEGORY = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
_INTERVAL = re.compile(r"^(\d+)([hd])$")

# Returns the newest non-system conversation timestamp per owner. The agent-host
# owns conversations, so the provider wires this to it.
ActivitySource = Callable[[], Awaitable[dict[str, str]]]


async def _no_system_caller() -> None:
    # TODO(PR 3): accept only the scheduler's service account.
    raise HTTPException(status_code=501, detail="needs system tasks")


async def _no_activity() -> dict[str, str]:
    return {}


def parse_interval(raw: str) -> timedelta:
    m = _INTERVAL.match(raw)
    if not m:
        raise HTTPException(status_code=400, detail="interval must look like 10d or 12h")
    n, unit = int(m.group(1)), m.group(2)
    return timedelta(days=n) if unit == "d" else timedelta(hours=n)


def _note_text(body: dict) -> str:
    text = body.get("note")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=400, detail="note is required")
    if len(text.encode()) > _MAX_NOTE_BYTES:
        raise HTTPException(status_code=400, detail="note is too long")
    return text.strip()


def _category(body: dict) -> str:
    cat = body.get("category")
    if not isinstance(cat, str) or not _CATEGORY.match(cat):
        raise HTTPException(status_code=400, detail="category must be a lowercase slug")
    return cat


@dataclass
class Personalization(Transport):
    name: str = "personalization"
    store: PersonalizationStore | None = field(default=None)
    # The relayed user; None means user_identity(authed). Tests may inject a fake.
    user: Callable[..., Awaitable[str]] | None = None
    system: Callable[..., Awaitable[None]] = field(default=_no_system_caller)
    activity: ActivitySource = field(default=_no_activity)

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter(tags=["personalization"])

        def _store() -> PersonalizationStore:
            if self.store is None:
                raise HTTPException(status_code=503, detail="personalization not configured")
            return self.store

        user = Depends(self.user or user_identity(authed))

        @router.get("/user/profile")
        async def get_profile(owner: str = user) -> dict:
            return {"profile": (await _store().profile(owner)).payload()}

        @router.patch("/user/profile")
        async def patch_profile(body: dict = Body(...), owner: str = user) -> dict:
            enabled = body.get("enabled")
            if not isinstance(enabled, bool):
                raise HTTPException(status_code=400, detail="enabled must be a boolean")
            # Turning it off stops future runs only; notes are kept.
            profile = await _store().update_profile(owner, enabled=enabled)
            return {"profile": profile.payload()}

        @router.get("/user/notes")
        async def list_notes(category: str = Query(default=""), owner: str = user) -> dict:
            notes = await _store().notes(owner, category or None)
            return {"notes": [n.payload() for n in notes]}

        @router.post("/user/notes")
        async def add_note(body: dict = Body(...), owner: str = user) -> dict:
            note = await _store().add_note(
                owner, category=_category(body), note=_note_text(body),
                source="user", pinned=bool(body.get("pinned", False)),
            )
            return {"note": note.payload()}

        @router.patch("/user/notes/{note_id}")
        async def patch_note(note_id: str, body: dict = Body(...), owner: str = user) -> dict:
            fields: dict = {}
            if "note" in body:
                fields["note"] = _note_text(body)
            if "category" in body:
                fields["category"] = _category(body)
            if "pinned" in body:
                fields["pinned"] = bool(body["pinned"])
            note = await _store().update_note(owner, note_id, as_agent=False, **fields)
            if note is None:
                raise HTTPException(status_code=404, detail="no such note")
            return {"note": note.payload()}

        @router.delete("/user/notes/{note_id}")
        async def delete_note(note_id: str, owner: str = user) -> dict:
            if not await _store().delete_note(owner, note_id, as_agent=False):
                raise HTTPException(status_code=404, detail="no such note")
            return {"deleted": note_id}

        @router.delete("/user/notes")
        async def delete_all(owner: str = user) -> dict:
            return {"deleted": await _store().delete_all_notes(owner)}

        @router.post("/user/refresh")
        async def refresh(owner: str = user) -> dict:
            profile = await _store().update_profile(owner, refresh_requested_at=now_iso())
            return {"profile": profile.payload()}

        @router.get("/system/eligible", dependencies=[Depends(self.system)])
        async def eligible(
            interval: str = Query(default="10d"), limit: int = Query(default=25, ge=1, le=500)
        ) -> dict:
            owners = await _store().eligible(
                interval=parse_interval(interval), limit=limit,
                latest_activity=await self.activity(), now=datetime.now(timezone.utc),
            )
            return {"owners": owners}

        @router.post("/system/spawned", dependencies=[Depends(self.system)])
        async def spawned(body: dict = Body(...)) -> dict:
            owner, conv = body.get("owner"), body.get("conversation_id")
            if not isinstance(owner, str) or not isinstance(conv, str):
                raise HTTPException(status_code=400, detail="owner and conversation_id are required")
            # Cleared only once a run is spawned, so a failed spawn is retried next hour.
            await _store().update_profile(
                owner, refresh_requested_at=None, last_run_conversation=conv
            )
            return {"ok": True}

        return router
