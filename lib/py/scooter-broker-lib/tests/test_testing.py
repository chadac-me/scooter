"""The shared schema checks catch drift and DDL, and create_schema refuses Postgres."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy import String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.testing import (
    assert_no_runtime_ddl,
    assert_rows_match_schema_sql,
    create_schema,
)


class _Base(DeclarativeBase):
    pass


class _Row(_Base):
    __tablename__ = "things"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    note: Mapped[str | None] = mapped_column(String, nullable=True)


SCHEMA = 'CREATE TABLE "things" (\n  "id" text NOT NULL,\n  "note" text NULL,\n  PRIMARY KEY ("id")\n);\n'


def test_matching_schema_passes(tmp_path):
    (tmp_path / "schema.sql").write_text(SCHEMA)
    assert_rows_match_schema_sql(_Base, tmp_path / "schema.sql")


@pytest.mark.parametrize("sql", [
    SCHEMA.replace('"note" text NULL', '"note" text NOT NULL'),
    SCHEMA.replace('  "note" text NULL,\n', ""),
    SCHEMA.replace('"things"', '"other"'),
])
def test_drift_fails(tmp_path, sql):
    (tmp_path / "schema.sql").write_text(sql)
    with pytest.raises(AssertionError):
        assert_rows_match_schema_sql(_Base, tmp_path / "schema.sql")


def test_runtime_ddl_is_caught_but_comments_are_not(tmp_path):
    (tmp_path / "ok.py").write_text("# create_all is not called here\n")
    assert_no_runtime_ddl(tmp_path)
    (tmp_path / "bad.py").write_text("Base.metadata.create_all(engine)\n")
    with pytest.raises(AssertionError, match="bad.py:1"):
        assert_no_runtime_ddl(tmp_path)


async def test_create_schema_refuses_postgres():
    store = SimpleNamespace(_engine=SimpleNamespace(dialect=SimpleNamespace(name="postgresql")))
    with pytest.raises(AssertionError, match="SQLite-only"):
        await create_schema(store, _Base)
