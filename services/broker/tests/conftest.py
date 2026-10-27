"""Shared test helpers, importable as `from conftest import ...` because pyproject sets pythonpath = ["tests"].

SQLite has no migrations, so the test suite builds its schema from the ORM models here,
while on Postgres the lib/sql migrations own the schema and the services issue no DDL.
"""

import pytest
from sqlalchemy.orm import DeclarativeBase

from scooter_broker_lib.store import StoreConfig

SQLITE = "sqlite+aiosqlite:///:memory:"


def sqlite_config(**kw) -> StoreConfig:
    """A StoreConfig pointed at a fresh in-memory SQLite database."""
    return StoreConfig(dsn=SQLITE, **kw)


async def create_schema(store, base: type[DeclarativeBase]) -> None:
    """Create `base`'s tables on the store's engine, SQLite only."""
    engine = store._engine
    assert engine.dialect.name == "sqlite", (
        f"create_schema is SQLite-only; got {engine.dialect.name!r}. "
        "On Postgres the lib/sql migrations own the schema."
    )
    async with engine.begin() as conn:
        await conn.run_sync(base.metadata.create_all)


@pytest.fixture(autouse=True)
def _fresh_token_cache(monkeypatch):
    """Tests reuse token strings for different SAs, so each starts with an empty verdict cache."""
    from broker.core import auth

    monkeypatch.setattr(auth, "_verifier", auth.Verifier(auth._kube_review))
