"""The conversation-mapping engine must survive a postgres restart, failover or idle-timeout.

The module is resolved through the import rather than a repo-relative path, since
each package's nix build sandbox contains only its own source.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from scooter_webhooks_lib import store

ENGINE_MODULES = [Path(store.__file__)]


def engine_calls(path: Path) -> list[ast.Call]:
    tree = ast.parse(path.read_text())
    return [
        n
        for n in ast.walk(tree)
        if isinstance(n, ast.Call)
        and (getattr(n.func, "id", None) or getattr(n.func, "attr", None)) == "create_async_engine"
    ]


@pytest.mark.parametrize("path", ENGINE_MODULES, ids=lambda p: p.name)
def test_engine_has_reconnect_guards(path: Path) -> None:
    calls = engine_calls(path)
    assert calls, f"{path} declares no create_async_engine call"
    for call in calls:
        kwargs = {kw.arg: kw.value for kw in call.keywords}
        pre_ping = kwargs.get("pool_pre_ping")
        assert isinstance(pre_ping, ast.Constant) and pre_ping.value is True, (
            f"{path.name}:{call.lineno} create_async_engine without pool_pre_ping=True — a "
            f"connection closed by a postgres restart/failover will be handed out dead"
        )
        recycle = kwargs.get("pool_recycle")
        assert isinstance(recycle, ast.Constant) and isinstance(recycle.value, int), (
            f"{path.name}:{call.lineno} create_async_engine without an int pool_recycle"
        )
        assert 0 < recycle.value <= 3600, (
            f"{path.name}:{call.lineno} pool_recycle={recycle.value}s should be <= 3600s"
        )
