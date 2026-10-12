"""`init_db` takes anything satisfying the `DatabaseConfig` protocol as an argument, not the app's config."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from scooter_webhooks_lib import store
from scooter_webhooks_lib.store import DatabaseConfig


@dataclass
class _Config:
    dsn: str = "sqlite+aiosqlite:///:memory:"
    db_host: str = "local"


@pytest.fixture(autouse=True)
async def _dispose():
    yield
    await store.close_db()


def test_the_apps_settings_shape_satisfies_the_protocol():
    # runtime_checkable, so this is the structural check the app's DatabaseSettings has to keep passing.
    assert isinstance(_Config(), DatabaseConfig)


async def test_init_db_uses_the_dsn_it_is_given():
    await store.init_db(_Config(dsn="sqlite+aiosqlite:///:memory:"))
    assert store._engine is not None
    assert store._engine.url.drivername == "sqlite+aiosqlite"


async def test_init_db_requires_a_config():
    with pytest.raises(TypeError):
        await store.init_db()


async def test_close_db_clears_the_engine():
    await store.init_db(_Config())
    await store.close_db()
    assert store._engine is None
    assert store._session_factory is None
