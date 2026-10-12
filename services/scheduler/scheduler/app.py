"""Scheduler service: a REST API for scheduled tasks plus a background loop that fires due tasks by spawning a fresh conversation per run."""

from __future__ import annotations

import asyncio
import contextlib
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, Header, HTTPException

from .config import require_relay_key, settings
from .cron import InvalidSchedule
from .logging_config import configure_logging, get_logger
from .metrics import MetricsSink, create_metrics
from .models import Run, Task, TaskCreate, TaskPatch
from .spawn import spawn_conversation
from .store import Store

configure_logging("scheduler", default_level=settings.log_level)

logger = get_logger("app")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def _fire(store: Store, task, metrics: MetricsSink) -> None:
    """Spawn one run for an already-claimed task and record it, without rescheduling since claim_due already advanced next_run_at."""
    start_ms = time.perf_counter() * 1000
    
    if hasattr(task, "_claim_lag_ms"):
        metrics.claim_lag(lag_ms=task._claim_lag_ms)
    
    run_id = await store.start_run(task.id)
    conv = await spawn_conversation(task.prompt, title=task.title, owner=task.owner)
    await store.finish_run(
        run_id,
        conversation_id=conv,
        status="spawned" if conv else "failed",
        error=None if conv else "spawn returned no conversation",
    )
    duration_ms = (time.perf_counter() * 1000) - start_ms
    metrics.fire_completed(status="spawned" if conv else "failed", duration_ms=duration_ms)
    logger.info(
        "fired task",
        extra={
            "task_id": task.id,
            "task_title": task.title,
            "conversation_id": conv,
            "status": "spawned" if conv else "failed",
            "duration_ms": duration_ms,
        },
    )


async def _scheduler_loop(store: Store, metrics: MetricsSink, stop: asyncio.Event) -> None:
    """Every tick, fire all due tasks; a missed window fires once on recovery, with no backfill storm."""
    tick_count = 0
    while not stop.is_set():
        outcome = "ok"
        try:
            now = _utcnow()
            # The gauges are fed before claiming, since claim_due zeroes the backlog, and a
            # gauge failure must never fail the tick.
            try:
                enabled, disabled, backlog = await store.gauge_counts(now)
                metrics.set_task_counts(enabled=enabled, disabled=disabled)
                metrics.set_due_backlog(count=backlog)
            except Exception:
                logger.warning("gauge refresh failed — task gauges will report their last value", exc_info=True)

            # Each due task is fired by exactly one replica, at most once per cron window.
            due = await store.claim_due(now)
            
            for task in due:
                try:
                    await _fire(store, task, metrics)
                except Exception:  # one bad task must not stall the loop
                    logger.exception("failed firing task", extra={"task_id": task.id})
                    outcome = "error"
            
            # The retention sweep runs every 120 ticks, roughly hourly at the default tick.
            tick_count += 1
            if settings.run_retention_days > 0 and tick_count % 120 == 0:
                try:
                    deleted = await store.prune_old_runs(retention_days=settings.run_retention_days, now=now)
                    if deleted > 0:
                        metrics.runs_pruned(count=deleted)
                        logger.info(
                            "pruned old runs",
                            extra={
                                "deleted_count": deleted,
                                "retention_days": settings.run_retention_days,
                            },
                        )
                except Exception:
                    logger.exception("retention sweep failed")
                    outcome = "error"
        except Exception:
            logger.exception("scheduler tick failed")
            outcome = "error"
        
        # Counted every tick, even with no due tasks, since this is the dead-loop detector.
        metrics.tick_completed(outcome=outcome)
        
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=settings.tick_seconds)


@asynccontextmanager
async def lifespan(app: FastAPI):
    store = Store(settings.dsn)
    app.state.store = store
    
    metrics = create_metrics(enabled=settings.otel_metrics_enabled)
    app.state.metrics = metrics
    
    stop = asyncio.Event()
    loop = asyncio.create_task(_scheduler_loop(store, metrics, stop))
    try:
        yield
    finally:
        stop.set()
        loop.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await loop
        await metrics.shutdown()
        await store.dispose()


app = FastAPI(title="agent-scheduler", version="0.1.0", lifespan=lifespan)


# The task owner is the forwarded x-auth-user identity, where an absent or empty header is
# the valid anonymous "" scope rather than an error.
def _owner(x_auth_user: str | None = Header(default=None)) -> str:
    return x_auth_user or ""


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


@app.post("/tasks", response_model=Task, dependencies=[Depends(require_relay_key)])
async def create_task(body: TaskCreate, owner: str = Depends(_owner)) -> Task:
    try:
        row = await app.state.store.create_task(
            title=body.title, prompt=body.prompt, cron=body.cron,
            timezone_=body.timezone, owner=owner, enabled=body.enabled,
        )
    except InvalidSchedule as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return Task.of(row)


# Every route below scopes to `owner`, reporting another owner's task as 404 rather than 403.
@app.get("/tasks", response_model=list[Task], dependencies=[Depends(require_relay_key)])
async def list_tasks(owner: str = Depends(_owner)) -> list[Task]:
    return [Task.of(r) for r in await app.state.store.list_tasks(owner)]


@app.get("/tasks/{task_id}", response_model=Task, dependencies=[Depends(require_relay_key)])
async def get_task(task_id: str, owner: str = Depends(_owner)) -> Task:
    row = await app.state.store.get_task(task_id, owner)
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    return Task.of(row)


@app.patch("/tasks/{task_id}", response_model=Task, dependencies=[Depends(require_relay_key)])
async def patch_task(task_id: str, body: TaskPatch, owner: str = Depends(_owner)) -> Task:
    try:
        row = await app.state.store.patch_task(
            task_id, owner, title=body.title, prompt=body.prompt, cron=body.cron,
            timezone=body.timezone, enabled=body.enabled,
        )
    except InvalidSchedule as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    return Task.of(row)


@app.delete("/tasks/{task_id}", status_code=204, dependencies=[Depends(require_relay_key)])
async def delete_task(task_id: str, owner: str = Depends(_owner)) -> None:
    if not await app.state.store.delete_task(task_id, owner):
        raise HTTPException(status_code=404, detail="task not found")


@app.get("/tasks/{task_id}/runs", response_model=list[Run], dependencies=[Depends(require_relay_key)])
async def list_runs(task_id: str, owner: str = Depends(_owner)) -> list[Run]:
    # Checked first so an unowned id 404s like every other route.
    if await app.state.store.get_task(task_id, owner) is None:
        raise HTTPException(status_code=404, detail="task not found")
    return [Run.of(r) for r in await app.state.store.list_runs(task_id, owner)]


@app.post("/tasks/{task_id}/run", response_model=Run, dependencies=[Depends(require_relay_key)])
async def run_now(task_id: str, owner: str = Depends(_owner)) -> Run:
    """Fire a task immediately, owner-scoped since firing spawns a conversation as the task's owner."""
    row = await app.state.store.get_task(task_id, owner)
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    await _fire(app.state.store, row, app.state.metrics)
    runs = await app.state.store.list_runs(task_id, owner, limit=1)
    return Run.of(runs[0])


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080)
