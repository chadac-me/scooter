"""A deployment that asks for TLS to Postgres must get it: the whole path from BROKER_DB_SSLMODE through settings and StoreConfig to the DSN, for every store."""

from __future__ import annotations

import pytest

from scooter_broker_lib.store import StoreConfig
from broker.config import BrokerSettings


def test_sslmode_reaches_the_dsn_as_asyncpgs_ssl_param():
    # asyncpg takes `ssl=`, not libpq's `sslmode=`.
    cfg = StoreConfig(db_password="pw", db_sslmode="require")
    assert cfg.resolved_dsn().endswith("?ssl=require")


def test_no_ssl_param_when_unset():
    assert "ssl" not in StoreConfig(db_password="pw").resolved_dsn()


def test_sqlite_dev_dsn_is_untouched_by_sslmode():
    # With no password the explicit dev DSN wins, and an ssl param would break it.
    cfg = StoreConfig(dsn="sqlite+aiosqlite:///:memory:", db_sslmode="require")
    assert cfg.resolved_dsn() == "sqlite+aiosqlite:///:memory:"


def test_env_var_the_module_emits_is_read(monkeypatch):
    monkeypatch.setenv("BROKER_DB_SSLMODE", "require")
    monkeypatch.setenv("BROKER_DB_PASSWORD", "pw")
    assert BrokerSettings().store_config().resolved_dsn().endswith("?ssl=require")


@pytest.mark.parametrize("dsn_setting", ["broker_db_dsn", ""])
def test_every_store_gets_the_same_components(monkeypatch, dsn_setting):
    """Every store assembles its StoreConfig through one place."""
    monkeypatch.setenv("BROKER_DB_SSLMODE", "require")
    monkeypatch.setenv("BROKER_DB_PASSWORD", "pw")
    monkeypatch.setenv("BROKER_DB_HOST", "pg.example")
    settings = BrokerSettings()
    dsn = settings.store_config(
        dsn=getattr(settings, dsn_setting) if dsn_setting else "").resolved_dsn()
    assert dsn == "postgresql+asyncpg://broker:pw@pg.example:5432/broker?ssl=require"
