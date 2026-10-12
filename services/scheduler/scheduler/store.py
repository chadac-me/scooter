"""Async SQLAlchemy store for scheduled tasks and runs."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from .cron import next_run, validate
from .models import Base, RunRow, TaskRow, new_id


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Store:
    def __init__(self, dsn: str):
        # pool_pre_ping recycles a connection the server closed underneath the pool, and
        # pool_recycle retires connections before common idle-timeout windows.
        self._engine = create_async_engine(
            dsn,
            future=True,
            pool_pre_ping=True,
            pool_recycle=1800,
        )
        self._session = async_sessionmaker(self._engine, expire_on_commit=False)

    async def dispose(self) -> None:
        await self._engine.dispose()

    # --- tasks --------------------------------------------------------------

    async def create_task(
        self, *, title: str, prompt: str, cron: str, timezone_: str, owner: str, enabled: bool
    ) -> TaskRow:
        """Persist a task, validating cron and timezone (InvalidSchedule) and computing the first next_run_at."""
        validate(cron, timezone_)
        now = _utcnow()
        row = TaskRow(
            id=new_id(), title=title, prompt=prompt, cron=cron, timezone=timezone_,
            owner=owner, enabled=enabled,
            next_run_at=next_run(cron, timezone_, now) if enabled else None,
        )
        async with self._session() as s:
            s.add(row)
            await s.commit()
            await s.refresh(row)
        return row

    # Every read and write below filters on `owner`, where None is the anonymous "" bucket,
    # a real scope rather than a wildcard.

    @staticmethod
    def _owner_eq(owner: str | None):
        """The owner predicate, mapping anonymous (None) to the "" bucket."""
        return TaskRow.owner == (owner or "")

    async def list_tasks(self, owner: str | None) -> list[TaskRow]:
        async with self._session() as s:
            q = select(TaskRow).where(self._owner_eq(owner)).order_by(TaskRow.created_at.desc())
            return list((await s.scalars(q)).all())

    async def get_task(self, task_id: str, owner: str | None) -> TaskRow | None:
        async with self._session() as s:
            row = await s.get(TaskRow, task_id)
            # Another owner's task is reported as absent, since a 403 would confirm the id exists.
            return row if row is not None and row.owner == (owner or "") else None

    async def patch_task(self, task_id: str, owner: str | None, **fields) -> TaskRow | None:
        """Update the given fields and recompute next_run_at, returning None for another owner's task."""
        async with self._session() as s:
            row = await s.get(TaskRow, task_id)
            if row is None or row.owner != (owner or ""):
                return None
            for k, v in fields.items():
                if v is not None:
                    setattr(row, k, v)
            if row.enabled:
                validate(row.cron, row.timezone)
                row.next_run_at = next_run(row.cron, row.timezone, _utcnow())
            else:
                row.next_run_at = None
            row.updated_at = _utcnow()
            await s.commit()
            await s.refresh(row)
            return row

    async def delete_task(self, task_id: str, owner: str | None) -> bool:
        async with self._session() as s:
            row = await s.get(TaskRow, task_id)
            if row is None or row.owner != (owner or ""):
                return False
            await s.delete(row)
            await s.commit()
            return True

    # --- scheduler loop -----------------------------------------------------

    async def due_tasks(self, now: datetime) -> list[TaskRow]:
        """Enabled tasks whose next_run_at is due, as a read-only selection that does not claim."""
        stmt = select(TaskRow).where(
            TaskRow.enabled.is_(True), TaskRow.next_run_at.is_not(None), TaskRow.next_run_at <= now
        )
        async with self._session() as s:
            return list((await s.scalars(stmt)).all())

    async def gauge_counts(self, now: datetime) -> tuple[int, int, int]:
        """(enabled, disabled, due_backlog) across all owners for the observable gauges, to be read before claim_due advances next_run_at."""
        enabled_count = func.count().filter(TaskRow.enabled.is_(True))
        disabled_count = func.count().filter(TaskRow.enabled.is_(False))
        backlog_count = func.count().filter(
            TaskRow.enabled.is_(True),
            TaskRow.next_run_at.is_not(None),
            TaskRow.next_run_at <= now,
        )
        async with self._session() as s:
            stmt = select(enabled_count, disabled_count, backlog_count).select_from(TaskRow)
            row = (await s.execute(stmt)).one()
        return int(row[0]), int(row[1]), int(row[2])

    async def claim_due(self, now: datetime) -> list[TaskRow]:
        """Atomically claim all due tasks by selecting them FOR UPDATE SKIP LOCKED and advancing next_run_at before releasing the lock, so a second replica skips them; returns the claimed rows."""
        stmt = (
            select(TaskRow)
            .where(TaskRow.enabled.is_(True), TaskRow.next_run_at.is_not(None), TaskRow.next_run_at <= now)
            .with_for_update(skip_locked=True)
        )
        async with self._session() as s:
            rows = list((await s.scalars(stmt)).all())
            for row in rows:
                # The claim lag rides along as a transient attribute for metrics; SQLite returns naive-UTC datetimes.
                if row.next_run_at:
                    next_run_aware = row.next_run_at if row.next_run_at.tzinfo else row.next_run_at.replace(tzinfo=timezone.utc)
                    row._claim_lag_ms = (now - next_run_aware).total_seconds() * 1000  # type: ignore
                # next_run is computed from `now` so a missed window fires once, with no backfill storm.
                row.last_run_at = now
                row.next_run_at = next_run(row.cron, row.timezone, now)
            await s.commit()
            return rows

    async def reschedule(self, task_id: str, *, last_run_at: datetime, next_run_at: datetime) -> None:
        async with self._session() as s:
            await s.execute(
                update(TaskRow).where(TaskRow.id == task_id).values(last_run_at=last_run_at, next_run_at=next_run_at)
            )
            await s.commit()

    # --- runs ---------------------------------------------------------------

    async def start_run(self, task_id: str) -> str:
        run_id = new_id()
        async with self._session() as s:
            s.add(RunRow(id=run_id, task_id=task_id, status="spawning"))
            await s.commit()
        return run_id

    async def finish_run(self, run_id: str, *, conversation_id: str | None, status: str, error: str | None) -> None:
        async with self._session() as s:
            await s.execute(
                update(RunRow).where(RunRow.id == run_id).values(
                    conversation_id=conversation_id, status=status, error=error
                )
            )
            await s.commit()

    async def list_runs(self, task_id: str, owner: str | None, limit: int = 50) -> list[RunRow]:
        """Runs for a task the caller owns, scoped by joining the parent task."""
        async with self._session() as s:
            stmt = (
                select(RunRow)
                .join(TaskRow, TaskRow.id == RunRow.task_id)
                .where(RunRow.task_id == task_id, self._owner_eq(owner))
                .order_by(RunRow.fired_at.desc())
                .limit(limit)
            )
            return list((await s.scalars(stmt)).all())

    async def prune_old_runs(self, *, retention_days: int, now: datetime) -> int:
        """Delete task_runs older than retention_days (0 disables the sweep) and return the count deleted."""
        if retention_days == 0:
            return 0
        
        cutoff = now - timedelta(days=retention_days)
        async with self._session() as s:
            result = await s.execute(delete(RunRow).where(RunRow.fired_at < cutoff))
            await s.commit()
            return result.rowcount
