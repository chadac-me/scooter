"""Tier 1: a claimed run that cannot spawn lands in task history as failed, never missing or stuck."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from scheduler.app import _fire
from scheduler.metrics import create_metrics
from scheduler.spawn import SpawnResult

from conftest import sqlite_store


async def _task(store):
    past = datetime.now(timezone.utc) - timedelta(hours=1)
    t = await store.create_task(
        title="t", prompt="p", cron="* * * * *", timezone_="UTC", owner="alice", enabled=True
    )
    await store.reschedule(t.id, last_run_at=past, next_run_at=past)
    return t


@pytest.mark.asyncio
async def test_a_spawn_that_RAISES_is_recorded_failed_not_left_spawning():
    store = await sqlite_store()
    t = await _task(store)
    with patch("scheduler.app.spawn", new_callable=AsyncMock, side_effect=RuntimeError("kaboom")):
        await _fire(store, t, create_metrics(enabled=False))
    runs = await store.list_runs(t.id, "alice")
    assert [(r.status, r.conversation_id) for r in runs] == [("failed", None)]
    assert "kaboom" in runs[0].error
    await store.dispose()


@pytest.mark.asyncio
async def test_a_failed_spawn_records_the_real_reason():
    store = await sqlite_store()
    t = await _task(store)
    with patch("scheduler.app.spawn", new_callable=AsyncMock, return_value=SpawnResult(None, "prompt failed: ReadTimeout")):
        await _fire(store, t, create_metrics(enabled=False))
    (run,) = await store.list_runs(t.id, "alice")
    assert run.status == "failed" and run.error == "prompt failed: ReadTimeout"
    await store.dispose()


@pytest.mark.asyncio
async def test_a_run_whose_start_failed_is_still_recorded_failed():
    store = await sqlite_store()
    t = await _task(store)
    real_start = store.start_run
    calls = {"n": 0}

    async def flaky_start(task_id):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("db blip")
        return await real_start(task_id)

    store.start_run = flaky_start
    with patch("scheduler.app.spawn", new_callable=AsyncMock) as spawn:
        await _fire(store, t, create_metrics(enabled=False))
    spawn.assert_not_called()
    (run,) = await store.list_runs(t.id, "alice")
    assert run.status == "failed" and "db blip" in run.error
    await store.dispose()
