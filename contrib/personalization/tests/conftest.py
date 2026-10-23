"""SQLite-only schema setup; on Postgres the contrib's sql/ migrations own the schema."""

from __future__ import annotations

from scooter_broker_lib.store import StoreConfig

SQLITE = "sqlite+aiosqlite:///:memory:"


def sqlite_config(**kw) -> StoreConfig:
    return StoreConfig(dsn=SQLITE, **kw)


async def create_schema(store, base) -> None:
    engine = store._engine
    assert engine.dialect.name == "sqlite", "create_schema is SQLite-only"
    async with engine.begin() as conn:
        await conn.run_sync(base.metadata.create_all)
