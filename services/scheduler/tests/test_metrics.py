"""OpenTelemetry metrics through an in-memory reader."""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from opentelemetry.metrics import CallbackOptions, Observation
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from scheduler.metrics import create_metrics
from scheduler.store import Store

from conftest import sqlite_store



@pytest_asyncio.fixture
async def store():
    s = await sqlite_store()
    yield s
    await s.dispose()


@pytest_asyncio.fixture
def metrics_reader():
    """In-memory metric reader for test assertions."""
    return InMemoryMetricReader()


@pytest_asyncio.fixture
def metrics_sink(metrics_reader):
    """Enabled metrics sink with an in-memory reader."""
    sink = create_metrics(enabled=True, reader_for_test=metrics_reader)
    yield sink
    import asyncio
    try:
        asyncio.get_event_loop().run_until_complete(sink.shutdown())
    except:
        pass


def _get_metric_value(reader, name: str, attributes: dict = None):
    """Read a metric value from the in-memory reader."""
    metrics = reader.get_metrics_data()
    for rm in metrics.resource_metrics:
        for sm in rm.scope_metrics:
            for metric in sm.metrics:
                if metric.name == name:
                    for point in metric.data.data_points:
                        if attributes is None:
                            return point.value
                        point_attrs = dict(point.attributes) if point.attributes else {}
                        if point_attrs == attributes:
                            return point.value
    return None


@pytest.mark.asyncio
async def test_successful_fire_increments_spawned(store, metrics_reader, metrics_sink):
    """A successful fire increments scheduler_fires_total{status=spawned}."""
    now = datetime.now(timezone.utc)
    past = now - timedelta(hours=1)
    t = await store.create_task(
        title="test", prompt="do it", cron="* * * * *", timezone_="UTC", owner="alice", enabled=True
    )
    await store.reschedule(t.id, last_run_at=past, next_run_at=past)

    with patch("scheduler.app.spawn_conversation", new_callable=AsyncMock) as mock_spawn:
        mock_spawn.return_value = "conv-123"
        
        from scheduler.app import _fire
        await _fire(store, t, metrics_sink)

    value = _get_metric_value(metrics_reader, "scheduler_fires_total", {"status": "spawned"})
    assert value == 1


@pytest.mark.asyncio
async def test_failed_spawn_increments_failed(store, metrics_reader, metrics_sink):
    """A failed spawn increments scheduler_fires_total{status=failed}."""
    now = datetime.now(timezone.utc)
    past = now - timedelta(hours=1)
    t = await store.create_task(
        title="test", prompt="do it", cron="* * * * *", timezone_="UTC", owner="alice", enabled=True
    )
    await store.reschedule(t.id, last_run_at=past, next_run_at=past)

    with patch("scheduler.app.spawn_conversation", new_callable=AsyncMock) as mock_spawn:
        mock_spawn.return_value = None
        
        from scheduler.app import _fire
        await _fire(store, t, metrics_sink)

    value = _get_metric_value(metrics_reader, "scheduler_fires_total", {"status": "failed"})
    assert value == 1


@pytest.mark.asyncio
async def test_tick_with_no_due_tasks_still_increments_ticks_total(store, metrics_reader, metrics_sink):
    """A tick with no due tasks must still increment scheduler_ticks_total, the dead-loop detector."""
    now = datetime.now(timezone.utc)
    future = now + timedelta(hours=1)
    await store.create_task(
        title="later", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=True
    )
    t = await store.list_tasks("a")
    await store.reschedule(t[0].id, last_run_at=now, next_run_at=future)

    due = await store.claim_due(now)
    assert len(due) == 0

    metrics_sink.tick_completed(outcome="ok")

    value = _get_metric_value(metrics_reader, "scheduler_ticks_total", {"outcome": "ok"})
    assert value == 1


def _observations(result):
    """Normalize a callback's return to a list of Observations."""
    assert result is not None, "an observable-gauge callback must RETURN observations, not None"
    return list(result)


def test_observable_gauge_callbacks_return_observations(metrics_sink):
    """An observable-gauge callback handed a CallbackOptions must return Observation objects."""
    metrics_sink.set_task_counts(enabled=5, disabled=2)
    metrics_sink.set_due_backlog(count=3)

    opts = CallbackOptions()

    task_obs = _observations(metrics_sink._observe_tasks(opts))
    for o in task_obs:
        assert isinstance(o, Observation), f"expected Observation, got {type(o).__name__}"
    by_enabled = {dict(o.attributes)["enabled"]: o.value for o in task_obs}
    assert by_enabled == {"true": 5, "false": 2}

    backlog_obs = _observations(metrics_sink._observe_backlog(opts))
    assert len(backlog_obs) == 1
    assert isinstance(backlog_obs[0], Observation)
    assert backlog_obs[0].value == 3


def test_observable_gauges_collect_through_the_reader(metrics_reader, metrics_sink):
    """A real collection cycle surfaces the gauge values."""
    metrics_sink.set_task_counts(enabled=7, disabled=1)
    metrics_sink.set_due_backlog(count=4)

    assert _get_metric_value(metrics_reader, "scheduler_tasks", {"enabled": "true"}) == 7
    assert _get_metric_value(metrics_reader, "scheduler_tasks", {"enabled": "false"}) == 1
    assert _get_metric_value(metrics_reader, "scheduler_due_backlog") == 4


@pytest.mark.asyncio
async def test_metrics_disabled_returns_noop_sink():
    """When metrics are disabled, create_metrics returns a no-op sink that never raises."""
    sink = create_metrics(enabled=False)
    
    sink.fire_started()
    sink.fire_completed(status="spawned", duration_ms=100)
    sink.tick_completed(outcome="ok")
    sink.set_task_counts(enabled=5, disabled=2)
    sink.runs_pruned(count=10)
    await sink.shutdown()


@pytest.mark.asyncio
async def test_retention_sweep_deletes_old_runs(store):
    """The retention sweep deletes only runs older than the cutoff."""
    now = datetime.now(timezone.utc)
    t = await store.create_task(
        title="x", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="a", enabled=True
    )
    
    old_run_id = await store.start_run(t.id)
    await store.finish_run(old_run_id, conversation_id="old-conv", status="spawned", error=None)
    
    recent_run_id = await store.start_run(t.id)
    await store.finish_run(recent_run_id, conversation_id="recent-conv", status="spawned", error=None)
    
    async with store._session() as s:
        from scheduler.models import RunRow
        from sqlalchemy import update
        await s.execute(
            update(RunRow).where(RunRow.id == old_run_id).values(fired_at=now - timedelta(days=100))
        )
        await s.commit()
    
    deleted = await store.prune_old_runs(retention_days=90, now=now)
    assert deleted == 1
    
    runs = await store.list_runs(t.id, "a")
    assert len(runs) == 1
    assert runs[0].id == recent_run_id


@pytest.mark.asyncio
async def test_retention_sweep_disabled_when_zero(store):
    """runRetentionDays=0 must disable the sweep."""
    now = datetime.now(timezone.utc)
    t = await store.create_task(
        title="x", prompt="p", cron="0 9 * * *", timezone_="UTC", owner="a", enabled=True
    )
    
    run_id = await store.start_run(t.id)
    await store.finish_run(run_id, conversation_id="ancient", status="spawned", error=None)
    
    async with store._session() as s:
        from scheduler.models import RunRow
        from sqlalchemy import update
        await s.execute(
            update(RunRow).where(RunRow.id == run_id).values(fired_at=now - timedelta(days=200))
        )
        await s.commit()
    
    deleted = await store.prune_old_runs(retention_days=0, now=now)
    assert deleted == 0
    
    runs = await store.list_runs(t.id, "a")
    assert len(runs) == 1
    assert runs[0].id == run_id


# --- gauge guard and feed ---------------------------------------------------


def test_gauge_callback_failure_is_reported_once_not_every_cycle(metrics_sink, caplog):
    """A raising gauge callback drops that cycle's data point and is reported once per episode."""
    boom = RuntimeError("gauge body exploded")

    def explode():
        raise boom

    with caplog.at_level(logging.ERROR):
        for _ in range(5):
            assert metrics_sink._guarded("scheduler_tasks", explode) == []

    failures = [r for r in caplog.records if "observable-gauge callback failed" in r.getMessage()]
    assert len(failures) == 1, f"expected 1 report for 5 failed collections, got {len(failures)}"

    # A clean collection re-arms the report, so a later episode is still visible.
    caplog.clear()
    assert metrics_sink._guarded("scheduler_tasks", lambda: [Observation(1)]) != []
    with caplog.at_level(logging.ERROR):
        metrics_sink._guarded("scheduler_tasks", explode)
    assert len([r for r in caplog.records if "observable-gauge callback failed" in r.getMessage()]) == 1


def test_sdk_never_logs_callback_failed_for_instrument(metrics_reader, metrics_sink, caplog):
    """The guard must absorb a raising gauge body so the SDK never logs "Callback failed for instrument", while the other gauge still collects."""
    metrics_sink.set_due_backlog(count=9)
    # Make the gauge body raise.
    del metrics_sink._task_count_enabled

    with caplog.at_level(logging.ERROR):
        assert _get_metric_value(metrics_reader, "scheduler_due_backlog") == 9

    sdk_errors = [r for r in caplog.records if "Callback failed for instrument" in r.getMessage()]
    assert not sdk_errors, f"the SDK logged {len(sdk_errors)} callback failures; the guard must absorb them"


def test_setters_coerce_to_int(metrics_sink):
    """Coercion happens at the setter, so a bad value is attributable to its caller."""
    metrics_sink.set_task_counts(enabled=True, disabled=2.0)
    metrics_sink.set_due_backlog(count=3.7)

    opts = CallbackOptions()
    by_enabled = {dict(o.attributes)["enabled"]: o.value for o in metrics_sink._observe_tasks(opts)}
    assert by_enabled == {"true": 1, "false": 2}
    assert all(isinstance(v, int) for v in by_enabled.values())
    assert metrics_sink._observe_backlog(opts)[0].value == 3


@pytest.mark.asyncio
async def test_gauge_counts_reports_enabled_disabled_and_backlog(store):
    """gauge_counts reports the enabled/disabled split plus the number of tasks actually overdue."""
    now = datetime.now(timezone.utc)
    past = now - timedelta(hours=1)
    future = now + timedelta(hours=1)

    overdue = await store.create_task(
        title="overdue", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=True
    )
    await store.reschedule(overdue.id, last_run_at=past, next_run_at=past)
    later = await store.create_task(
        title="later", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=True
    )
    await store.reschedule(later.id, last_run_at=past, next_run_at=future)
    off = await store.create_task(
        title="off", prompt="p", cron="* * * * *", timezone_="UTC", owner="b", enabled=False
    )
    await store.reschedule(off.id, last_run_at=past, next_run_at=past)

    enabled, disabled, backlog = await store.gauge_counts(now)

    assert (enabled, disabled) == (2, 1)
    # A disabled task that is overdue is not backlog.
    assert backlog == 1


@pytest.mark.asyncio
async def test_tick_feeds_the_gauges_before_claiming(store, metrics_reader, metrics_sink):
    """The tick must feed the gauges before claim_due zeroes the backlog."""
    now = datetime.now(timezone.utc)
    past = now - timedelta(hours=1)
    t = await store.create_task(
        title="overdue", prompt="p", cron="* * * * *", timezone_="UTC", owner="a", enabled=True
    )
    await store.reschedule(t.id, last_run_at=past, next_run_at=past)

    stop = asyncio.Event()

    async def one_tick():
        await asyncio.sleep(0.05)
        stop.set()

    from scheduler.app import _scheduler_loop

    with patch("scheduler.app.spawn_conversation", new_callable=AsyncMock) as mock_spawn:
        mock_spawn.return_value = "conv-1"
        await asyncio.gather(_scheduler_loop(store, metrics_sink, stop), one_tick())

    assert _get_metric_value(metrics_reader, "scheduler_tasks", {"enabled": "true"}) == 1
    assert _get_metric_value(metrics_reader, "scheduler_tasks", {"enabled": "false"}) == 0
    assert _get_metric_value(metrics_reader, "scheduler_due_backlog") == 1


@pytest.mark.asyncio
async def test_gauge_refresh_failure_does_not_fail_the_tick(store, metrics_reader, metrics_sink):
    """A raising gauge refresh must not fail the tick or poison its outcome."""
    stop = asyncio.Event()

    async def one_tick():
        await asyncio.sleep(0.05)
        stop.set()

    from scheduler.app import _scheduler_loop

    with patch.object(store, "gauge_counts", side_effect=RuntimeError("no db")):
        await asyncio.gather(_scheduler_loop(store, metrics_sink, stop), one_tick())

    assert _get_metric_value(metrics_reader, "scheduler_ticks_total", {"outcome": "ok"}) == 1
