"""This contrib must never create tables on Postgres: its tables are declared in sql/schema.sql and applied by the Atlas migration Job."""

from __future__ import annotations

import ast
import pathlib

import pytest

from scooter_broker_lib.store import StoreConfig
from scooter_contrib_shares.store import ShareStore

CONTRIB_SRC = pathlib.Path(__file__).resolve().parents[1] / "scooter_contrib_shares"


def test_the_store_exposes_NO_schema_creating_method():
    assert not hasattr(ShareStore, "init")


def test_no_module_in_this_contrib_calls_create_all():
    # Walks the AST rather than the text, so a comment mentioning create_all does not trip it.
    assert CONTRIB_SRC.is_dir(), f"source not found at {CONTRIB_SRC}"
    offenders = []
    for path in sorted(CONTRIB_SRC.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Attribute) and node.attr in {"create_all", "drop_all"}:
                offenders.append(f"{path.relative_to(CONTRIB_SRC)}:{node.lineno}")
    assert offenders == [], (
        f"schema DDL in contrib code: {offenders}. The tables are declared in sql/schema.sql "
        "and applied by the migration Job; tests build SQLite schemas via conftest.create_schema."
    )


@pytest.mark.asyncio
async def test_create_schema_REFUSES_a_postgres_engine():
    from conftest import create_schema
    from scooter_contrib_shares import store as shares_store

    store = ShareStore(StoreConfig(dsn="postgresql+asyncpg://u:p@127.0.0.1:1/nope"))
    with pytest.raises(AssertionError, match="SQLite-only"):
        await create_schema(store, shares_store._Base)
