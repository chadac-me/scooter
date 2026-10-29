"""The row models in store.py mirror sql/schema.sql, the DDL Atlas applies.

Core generates no bindings for a contrib's database, so this is what keeps the two
from drifting: a column added to one and not the other fails here, not in prod.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from scooter_contrib_shares.store import _ShareRow, _VersionRow

SCHEMA = Path(__file__).resolve().parents[1] / "sql" / "schema.sql"


def _ddl_columns(table: str) -> tuple[dict[str, bool], list[str]]:
    """Column -> nullable, and the primary key, parsed from schema.sql."""
    body = re.search(rf'CREATE TABLE "{table}" \((.*?)\n\);', SCHEMA.read_text(), re.S)
    assert body, f"{table} is not declared in {SCHEMA}"
    cols: dict[str, bool] = {}
    pk: list[str] = []
    for line in body.group(1).splitlines():
        line = line.strip().rstrip(",")
        if m := re.match(r'PRIMARY KEY \((.*)\)', line):
            pk = re.findall(r'"([^"]+)"', m.group(1))
        elif m := re.match(r'"([^"]+)"\s+(.*)', line):
            cols[m.group(1)] = "NOT NULL" not in m.group(2)
    return cols, pk


@pytest.mark.parametrize("row", [_ShareRow, _VersionRow], ids=lambda r: r.__tablename__)
def test_row_model_matches_schema_sql(row):
    cols, pk = _ddl_columns(row.__tablename__)
    table = row.__table__
    assert {c.name: bool(c.nullable) for c in table.columns} == cols
    assert sorted(c.name for c in table.primary_key.columns) == sorted(pk)
