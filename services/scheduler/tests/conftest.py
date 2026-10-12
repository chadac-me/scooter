"""Shared test fixtures, which build the SQLite schema from the ORM models since the service issues no DDL."""

from scheduler.models import Base
from scheduler.store import Store

SQLITE = "sqlite+aiosqlite:///:memory:"


async def sqlite_store() -> Store:
    """A Store on a fresh in-memory database, with its tables created."""
    store = Store(SQLITE)
    async with store._engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return store
