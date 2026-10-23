"""The personalization tables are declared in contrib/personalization/sql/schema.sql; no contrib code creates them."""

from __future__ import annotations

import ast
import pathlib

SRC = pathlib.Path(__file__).resolve().parents[1] / "scooter_contrib_personalization"


def test_no_module_calls_create_all():
    offenders = [
        f"{p.relative_to(SRC)}:{n.lineno}"
        for p in sorted(SRC.rglob("*.py"))
        for n in ast.walk(ast.parse(p.read_text()))
        if isinstance(n, ast.Attribute) and n.attr in {"create_all", "drop_all"}
    ]
    assert offenders == []
