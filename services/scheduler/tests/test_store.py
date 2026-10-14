"""Tier 1: the async store on SQLite."""

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio

from scheduler.store import Store
from scheduler.cron import InvalidSchedule

from conftest import sqlite_store



@pytest_asyncio.fixture
async def store():
    s = await sqlite_store()
    yield s
    await s.dispose()


@pytest.mark.asyncio
async def test_create_computes_next_run(store):
    t = await store.create_task(
        title="daily", prompt="do the thing", cron="0 9 * * *", timezone_="UTC",
        owner="alice", enabled=True,
    )
    assert t.owner == "alice"
    assert t.next_run_at is not None
    # The stored value's tz-awareness is backend-dependent (SQLite returns naive UTC).


@pytest.mark.asyncio
async def test_create_rejects_bad_cron(store):
    with pytest.raises(InvalidSchedule):
        await store.create_task(
            title="x", prompt="p", cron="nonsense", timezone_="UTC", owner="a", enabled=True,
        )


@pytest.mark.asyncio
async def test_disabled_task_has_no_next_run(store):
    t = await store.create_task(
        title="off", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="a", enabled=False,
    )
    assert t.next_run_at is None


@pytest.mark.asyncio
async def test_due_tasks_selects_only_overdue_enabled(store):
    past = datetime.now(timezone.utc) - timedelta(hours=1)
    future = datetime.now(timezone.utc) + timedelta(hours=1)
    due_task = await store.create_task(title="due", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=True)
    await store.reschedule(due_task.id, last_run_at=past, next_run_at=past)
    later = await store.create_task(title="later", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=True)
    await store.reschedule(later.id, last_run_at=past, next_run_at=future)
    off = await store.create_task(title="off", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=False)
    await store.reschedule(off.id, last_run_at=past, next_run_at=past)

    due = await store.due_tasks(datetime.now(timezone.utc))
    due_ids = {t.id for t in due}
    assert due_task.id in due_ids
    assert later.id not in due_ids
    assert off.id not in due_ids


@pytest.mark.asyncio
async def test_claim_due_advances_next_run_atomically(store):
    """claim_due must advance next_run_at as part of claiming, so a second claim in the same instant returns nothing."""
    now = datetime.now(timezone.utc)
    past = now - timedelta(hours=1)
    t = await store.create_task(title="due", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=True)
    await store.reschedule(t.id, last_run_at=past, next_run_at=past)

    first = await store.claim_due(now)
    assert {c.id for c in first} == {t.id}

    second = await store.claim_due(now)
    assert second == []

    # SQLite returns naive-UTC datetimes, so normalize before comparing.
    row = await store.get_task(t.id, "a")
    next_at = row.next_run_at if row.next_run_at.tzinfo else row.next_run_at.replace(tzinfo=timezone.utc)
    assert next_at > now
    assert row.last_run_at is not None


@pytest.mark.asyncio
async def test_patch_recomputes_next_run(store):
    t = await store.create_task(title="x", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="a", enabled=True)
    p = await store.patch_task(t.id, "a", enabled=False)
    assert p.next_run_at is None
    p = await store.patch_task(t.id, "a", enabled=True)
    assert p.next_run_at is not None


@pytest.mark.asyncio
async def test_run_lifecycle(store):
    t = await store.create_task(title="x", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="a", enabled=True)
    run_id = await store.start_run(t.id)
    await store.finish_run(run_id, conversation_id="conv-1", status="spawned", error=None)
    runs = await store.list_runs(t.id, "a")
    assert len(runs) == 1
    assert runs[0].conversation_id == "conv-1"
    assert runs[0].status == "spawned"


@pytest.mark.asyncio
async def test_delete_cascades_runs(store):
    t = await store.create_task(title="x", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="a", enabled=True)
    await store.start_run(t.id)
    assert await store.delete_task(t.id, "a") is True
    assert await store.get_task(t.id, "a") is None
