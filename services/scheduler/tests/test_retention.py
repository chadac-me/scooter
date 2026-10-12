"""The task_runs retention sweep."""

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio

from scheduler.store import Store

from conftest import sqlite_store



@pytest_asyncio.fixture
async def store():
    s = await sqlite_store()
    yield s
    await s.dispose()


@pytest.mark.asyncio
async def test_prune_deletes_only_old_runs(store):
    """The retention sweep deletes only rows older than the cutoff."""
    now = datetime.now(timezone.utc)
    cutoff_days = 7

    task = await store.create_task(
        title="test", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="alice", enabled=True
    )

    old_run = await store.start_run(task.id)
    recent_run = await store.start_run(task.id)

    async with store._session() as s:
        from scheduler.models import RunRow
        from sqlalchemy import update

        await s.execute(
            update(RunRow).where(RunRow.id == old_run).values(fired_at=now - timedelta(days=10))
        )
        await s.execute(
            update(RunRow).where(RunRow.id == recent_run).values(fired_at=now - timedelta(days=3))
        )
        await s.commit()

    deleted_count = await store.prune_old_runs(retention_days=cutoff_days, now=now)

    assert deleted_count == 1

    all_runs = await store.list_runs(task.id, "alice", limit=100)
    run_ids = {r.id for r in all_runs}
    assert old_run not in run_ids
    assert recent_run in run_ids


@pytest.mark.asyncio
async def test_prune_with_zero_retention_does_nothing(store):
    """runRetentionDays=0 must disable the sweep."""
    now = datetime.now(timezone.utc)

    task = await store.create_task(
        title="test", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="alice", enabled=True
    )

    old_run = await store.start_run(task.id)

    async with store._session() as s:
        from scheduler.models import RunRow
        from sqlalchemy import update

        await s.execute(
            update(RunRow).where(RunRow.id == old_run).values(fired_at=now - timedelta(days=100))
        )
        await s.commit()

    deleted_count = await store.prune_old_runs(retention_days=0, now=now)
    assert deleted_count == 0

    all_runs = await store.list_runs(task.id, "alice", limit=100)
    assert len(all_runs) == 1
    assert all_runs[0].id == old_run


@pytest.mark.asyncio
async def test_prune_with_no_old_runs(store):
    """The sweep on a fresh DB returns 0."""
    deleted_count = await store.prune_old_runs(retention_days=30, now=datetime.now(timezone.utc))
    assert deleted_count == 0


@pytest.mark.asyncio
async def test_prune_boundary_condition(store):
    """A run at exactly the cutoff boundary is not deleted."""
    now = datetime.now(timezone.utc)
    cutoff_days = 7

    task = await store.create_task(
        title="test", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="alice", enabled=True
    )

    boundary_run = await store.start_run(task.id)

    async with store._session() as s:
        from scheduler.models import RunRow
        from sqlalchemy import update

        await s.execute(
            update(RunRow).where(RunRow.id == boundary_run).values(fired_at=now - timedelta(days=cutoff_days))
        )
        await s.commit()

    deleted_count = await store.prune_old_runs(retention_days=cutoff_days, now=now)
    assert deleted_count == 0

    all_runs = await store.list_runs(task.id, "alice", limit=100)
    assert len(all_runs) == 1
