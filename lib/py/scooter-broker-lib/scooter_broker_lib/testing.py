"""Test helpers for stores whose tables Atlas migrations own on Postgres.

SQLite has no migrations, so suites build the schema from the row models with
`create_schema`. The two `assert_*` checks keep a contrib's row models and code
honest against its `sql/schema.sql`.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

from sqlalchemy.orm import DeclarativeBase

from .store import StoreConfig

SQLITE = "sqlite+aiosqlite:///:memory:"


def sqlite_config(**kw) -> StoreConfig:
    """A StoreConfig pointed at a fresh in-memory SQLite database."""
    return StoreConfig(dsn=SQLITE, **kw)


async def create_schema(store, base: type[DeclarativeBase]) -> None:
    """Create `base`'s tables on the store's engine, SQLite only."""
    engine = store._engine
    assert engine.dialect.name == "sqlite", (
        f"create_schema is SQLite-only; got {engine.dialect.name!r}. "
        "On Postgres the sql/ migrations own the schema."
    )
    async with engine.begin() as conn:
        await conn.run_sync(base.metadata.create_all)


def _ddl_columns(sql: str, table: str) -> tuple[dict[str, bool], list[str]]:
    """Column -> nullable, and the primary key, of `table` in Atlas-formatted DDL."""
    body = re.search(rf'CREATE TABLE "{table}" \((.*?)\n\);', sql, re.S)
    assert body, f"{table} is not declared in schema.sql"
    cols: dict[str, bool] = {}
    pk: list[str] = []
    for line in body.group(1).splitlines():
        line = line.strip().rstrip(",")
        if m := re.match(r"PRIMARY KEY \((.*)\)", line):
            pk = re.findall(r'"([^"]+)"', m.group(1))
        elif m := re.match(r'"([^"]+)"\s+(.*)', line):
            cols[m.group(1)] = "NOT NULL" not in m.group(2)
    return cols, pk


def assert_rows_match_schema_sql(base: type[DeclarativeBase], schema: Path) -> None:
    """Every table on `base` has the columns, nullability and key `schema` declares."""
    sql = schema.read_text()
    assert base.metadata.tables, f"{base.__name__} declares no tables"
    for table in base.metadata.tables.values():
        cols, pk = _ddl_columns(sql, table.name)
        assert {c.name: bool(c.nullable) for c in table.columns} == cols, table.name
        assert sorted(c.name for c in table.primary_key.columns) == sorted(pk), table.name


def assert_no_runtime_ddl(src: Path) -> None:
    """No module under `src` calls `create_all` or `drop_all`."""
    assert src.is_dir(), f"source not found at {src}"
    # The AST, not the text, so a comment naming create_all passes.
    offenders = [
        f"{path.relative_to(src)}:{node.lineno}"
        for path in sorted(src.rglob("*.py"))
        for node in ast.walk(ast.parse(path.read_text()))
        if isinstance(node, ast.Attribute) and node.attr in {"create_all", "drop_all"}
    ]
    assert offenders == [], (
        f"schema DDL in {src.name}: {offenders}. The sql/ migrations own the schema; "
        "tests build SQLite schemas with scooter_broker_lib.testing.create_schema."
    )
