"""A task with a target conversation prompts it instead of spawning, and stops once it is gone."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import pytest_asyncio

import scheduler.app as appmod
from scheduler.app import _fire
from scheduler.metrics import create_metrics
from scheduler.spawn import SpawnResult

from conftest import sqlite_store

AUTH = {"x-auth-user": "alice"}


async def _due(store, conversation_id="conv-target"):
    past = datetime.now(timezone.utc) - timedelta(hours=1)
    t = await store.create_task(
        title="t", prompt="p", cron="* * * * *", timezone_="UTC", owner="alice", enabled=True,
        conversation_id=conversation_id,
    )
    await store.reschedule(t.id, last_run_at=past, next_run_at=past)
    return t


@pytest.mark.asyncio
async def test_a_targeted_task_delivers_to_its_conversation_without_spawning():
    store = await sqlite_store()
    t = await _due(store)
    with (
        patch("scheduler.app.deliver", new_callable=AsyncMock, return_value=SpawnResult("conv-target")) as deliver,
        patch("scheduler.app.spawn", new_callable=AsyncMock) as spawn,
    ):
        await _fire(store, t, create_metrics(enabled=False))
    deliver.assert_awaited_once_with("conv-target", "p", owner="alice")
    spawn.assert_not_called()
    (run,) = await store.list_runs(t.id, "alice")
    assert (run.status, run.conversation_id) == ("delivered", "conv-target")
    await store.dispose()


@pytest.mark.asyncio
async def test_a_gone_target_fails_the_run_and_disables_the_task():
    store = await sqlite_store()
    t = await _due(store)
    gone = SpawnResult(None, "conversation conv-target no longer exists", gone=True)
    with patch("scheduler.app.deliver", new_callable=AsyncMock, return_value=gone):
        await _fire(store, t, create_metrics(enabled=False))
    (run,) = await store.list_runs(t.id, "alice")
    assert run.status == "failed" and "no longer exists" in run.error
    row = await store.get_task(t.id, "alice")
    assert row.enabled is False and row.next_run_at is None
    await store.dispose()


@pytest.mark.asyncio
async def test_a_transient_delivery_failure_keeps_the_task_enabled():
    store = await sqlite_store()
    t = await _due(store)
    with patch("scheduler.app.deliver", new_callable=AsyncMock, return_value=SpawnResult(None, "prompt rejected: 503")):
        await _fire(store, t, create_metrics(enabled=False))
    (run,) = await store.list_runs(t.id, "alice")
    assert run.status == "failed"
    assert (await store.get_task(t.id, "alice")).enabled is True
    await store.dispose()


@pytest_asyncio.fixture
async def client():
    store = await sqlite_store()
    appmod.app.state.store = store
    appmod.app.state.metrics = create_metrics(enabled=False)
    transport = httpx.ASGITransport(app=appmod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        yield c
    await store.dispose()


@pytest.mark.asyncio
async def test_the_target_is_set_at_creation_and_cannot_be_patched(client):
    body = {"title": "t", "prompt": "p", "cron": "0 9 * * *", "conversation_id": "conv-1"}
    created = (await client.post("/tasks", json=body, headers=AUTH)).json()
    assert created["conversation_id"] == "conv-1"
    tid = created["id"]
    kept = (await client.patch(f"/tasks/{tid}", json={"prompt": "new"}, headers=AUTH)).json()
    assert (kept["prompt"], kept["conversation_id"]) == ("new", "conv-1")
    for target in ("conv-2", None):
        r = await client.patch(f"/tasks/{tid}", json={"conversation_id": target}, headers=AUTH)
        assert r.status_code == 422
    assert (await client.get(f"/tasks/{tid}", headers=AUTH)).json()["conversation_id"] == "conv-1"


@pytest.mark.asyncio
async def test_a_task_without_a_target_still_spawns(client):
    tid = (await client.post("/tasks", json={"title": "t", "prompt": "p", "cron": "0 9 * * *"}, headers=AUTH)).json()["id"]
    with patch("scheduler.app.spawn", new_callable=AsyncMock, return_value=SpawnResult("conv-new")):
        r = await client.post(f"/tasks/{tid}/run", headers=AUTH)
    assert r.json()["status"] == "spawned" and r.json()["conversation_id"] == "conv-new"
