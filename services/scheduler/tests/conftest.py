"""Shared test fixtures, which build the SQLite schema from the ORM models since the service issues no DDL."""

from sqlalchemy import event

from scheduler.models import Base
from scheduler.store import Store

SQLITE = "sqlite+aiosqlite:///:memory:"


async def sqlite_store(dsn: str = SQLITE) -> Store:
    """A Store on a fresh database (in memory by default), with its tables created and
    foreign keys enforced, so ON DELETE CASCADE behaves as it does on Postgres."""
    store = Store(dsn)

    @event.listens_for(store._engine.sync_engine, "connect")
    def _fks(conn, _record):
        conn.execute("PRAGMA foreign_keys=ON")

    async with store._engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return store


async def file_store(tmp_path) -> Store:
    """A Store on a SQLite file, for tests whose concurrent sessions must share one database."""
    return await sqlite_store(f"sqlite+aiosqlite:///{tmp_path}/scheduler.db")
