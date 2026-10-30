"""The /user/* routes behind the /contrib-api relay: only a relayed user gets in, and each user sees only their own notes."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from scooter_broker_lib.types import Identity, Provider

from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_contrib_personalization.store import PersonalizationStore, _Base
from scooter_contrib_personalization.transport import Personalization


@pytest.fixture
async def app():
    store = PersonalizationStore(sqlite_config())
    await create_schema(store, _Base)
    transport = Personalization(store=store)
    caller: dict[str, Identity] = {}

    async def authed() -> Identity:
        return caller["identity"]

    a = FastAPI()
    provider = Provider(name="personalization", transports=[transport], enabled=True)
    a.include_router(transport.routes(provider, authed), prefix="/personalization")
    a.state.caller = caller
    return a


def as_(app, relayed_user: str | None) -> AsyncClient:
    app.state.caller["identity"] = Identity(
        conversation_id="", namespace="ns", service_account="agent-host", relayed_user=relayed_user
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://broker")


async def test_a_caller_the_relay_did_not_name_is_refused(app):
    """A sandbox (or any non-relay caller) has no relayed user, so every /user route is 403."""
    async with as_(app, None) as c:
        for method, path in [("GET", "profile"), ("GET", "notes"), ("POST", "refresh"), ("DELETE", "notes")]:
            r = await c.request(method, f"/personalization/user/{path}")
            assert r.status_code == 403, (method, path, r.text)


async def test_notes_are_scoped_to_the_relayed_user(app):
    async with as_(app, "alice") as c:
        r = await c.post("/personalization/user/notes", json={"category": "preferences", "note": "terse"})
        assert r.status_code in (200, 201), r.text
        alice_note = r.json()["note"]["id"]
    async with as_(app, "bob") as c:
        assert (await c.get("/personalization/user/notes")).json()["notes"] == []
        # Bob cannot reach Alice's note by id, to edit or delete it.
        assert (await c.patch(f"/personalization/user/notes/{alice_note}", json={"note": "x"})).status_code == 404
        assert (await c.delete(f"/personalization/user/notes/{alice_note}")).status_code == 404
        # Nor does deleting all of his notes touch hers.
        await c.delete("/personalization/user/notes")
    async with as_(app, "alice") as c:
        notes = (await c.get("/personalization/user/notes")).json()["notes"]
        assert [n["note"] for n in notes] == ["terse"]


async def test_the_profile_toggle_is_per_user(app):
    async with as_(app, "alice") as c:
        r = await c.patch("/personalization/user/profile", json={"enabled": False})
        assert r.status_code == 200, r.text
        assert (await c.get("/personalization/user/profile")).json()["profile"]["enabled"] is False
    async with as_(app, "bob") as c:
        assert (await c.get("/personalization/user/profile")).json()["profile"]["enabled"] is True
