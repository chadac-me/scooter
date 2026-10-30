"""Tier 1: services must never create tables on Postgres.

Tables are declared in lib/sql/<db>/schema.sql and applied by the Atlas migration Job,
so the production code must have no way to create them.
"""

import ast
import pathlib

SERVICE_SRC = pathlib.Path(__file__).resolve().parents[1] / "broker"


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
        "applied by the migration Job."
    )
