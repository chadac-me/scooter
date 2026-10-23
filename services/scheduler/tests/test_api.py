"""Tier 1: the REST API, with the owner taken from identity."""

import httpx

from scheduler.spawn import SpawnResult
import pytest
import pytest_asyncio

import scheduler.app as appmod
from scheduler.metrics import create_metrics
from scheduler.store import Store

from conftest import sqlite_store



@pytest_asyncio.fixture
async def client(monkeypatch):
    store = await sqlite_store()
    appmod.app.state.store = store
    # The lifespan normally sets app.state.metrics, but these tests drive the app without it.
    appmod.app.state.metrics = create_metrics(enabled=False)

    async def fake_spawn(prompt, *, title, owner, client=None):
        return SpawnResult("conv-fake")

    monkeypatch.setattr(appmod, "spawn", fake_spawn)

    transport = httpx.ASGITransport(app=appmod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        yield c
    await store.dispose()


AUTH = {"x-auth-user": "alice"}


@pytest.mark.asyncio
async def test_create_sets_owner_from_identity_not_body(client):
    r = await client.post("/tasks", json={"title": "daily", "prompt": "do X", "cron": "0 9 * * *"}, headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["owner"] == "alice"
    assert r.json()["next_run_at"] is not None


@pytest.mark.asyncio
async def test_create_anonymous_uses_unowned_bucket(client):
    # No x-auth-user is the anonymous scope, not an error.
    r = await client.post("/tasks", json={"title": "x", "prompt": "p", "cron": "0 9 * * *"})
    assert r.status_code == 200, r.text
    assert r.json()["owner"] == ""


@pytest.mark.asyncio
async def test_create_rejects_bad_cron_with_422(client):
    r = await client.post("/tasks", json={"title": "x", "prompt": "p", "cron": "garbage"}, headers=AUTH)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_list_get_patch_delete(client):
    tid = (await client.post("/tasks", json={"title": "t", "prompt": "p", "cron": "0 9 * * *"}, headers=AUTH)).json()["id"]
    assert any(t["id"] == tid for t in (await client.get("/tasks", headers=AUTH)).json())
    assert (await client.get(f"/tasks/{tid}", headers=AUTH)).json()["title"] == "t"
    p = await client.patch(f"/tasks/{tid}", json={"prompt": "new", "enabled": False}, headers=AUTH)
    assert p.json()["prompt"] == "new"
    assert p.json()["next_run_at"] is None
    assert (await client.delete(f"/tasks/{tid}", headers=AUTH)).status_code == 204
    assert (await client.get(f"/tasks/{tid}", headers=AUTH)).status_code == 404


@pytest.mark.asyncio
async def test_run_now_spawns_and_records(client):
    tid = (await client.post("/tasks", json={"title": "t", "prompt": "p", "cron": "0 9 * * *"}, headers=AUTH)).json()["id"]
    r = await client.post(f"/tasks/{tid}/run", headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["conversation_id"] == "conv-fake"
    assert r.json()["status"] == "spawned"
    runs = (await client.get(f"/tasks/{tid}/runs", headers=AUTH)).json()
    assert len(runs) == 1
