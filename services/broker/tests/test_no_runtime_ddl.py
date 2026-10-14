"""Tier 1: services must never create tables on Postgres.

Tables are declared in lib/sql/<db>/schema.sql and applied by the Atlas migration Job;
schema creation is a test concern (conftest.create_schema, SQLite only), so these tests
assert the production code has no way to do it.
"""

import ast
import pathlib

import pytest

from scooter_broker_lib.store import StoreConfig
from broker.registry.store import ModuleRegistryStore

SERVICE_SRC = pathlib.Path(__file__).resolve().parents[1] / "broker"


@pytest.mark.parametrize(
    "store_cls", [ModuleRegistryStore], ids=lambda c: c.__name__
)
def test_stores_expose_NO_schema_creating_method(store_cls):
    assert not hasattr(store_cls, "init")


def test_no_service_module_calls_create_all():
    # The AST is scanned rather than the text, so a comment mentioning create_all does not trip it.
    offenders = []
    for path in SERVICE_SRC.rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr in {"create_all", "drop_all"}:
                offenders.append(f"{path.relative_to(SERVICE_SRC)}:{node.lineno}")
    assert offenders == [], (
        f"schema DDL in service code: {offenders}. Tables are declared in lib/sql and "
        "applied by the migration Job; tests build SQLite schemas via conftest.create_schema."
    )


@pytest.mark.asyncio
async def test_create_schema_REFUSES_a_postgres_engine():
    from conftest import create_schema
    from broker.registry import store as registry_store

    store = ModuleRegistryStore(StoreConfig(dsn="postgresql+asyncpg://u:p@127.0.0.1:1/nope"))
    with pytest.raises(AssertionError, match="SQLite-only"):
        await create_schema(store, registry_store._Base)


@pytest.mark.asyncio
async def test_create_schema_DOES_build_tables_on_sqlite():
    from conftest import create_schema, sqlite_config
    from broker.registry import store as registry_store

    store = ModuleRegistryStore(sqlite_config())
    await create_schema(store, registry_store._Base)
    assert await store.list_visible(viewer="someone") == []
