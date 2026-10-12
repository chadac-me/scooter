"""Every `settings.<name>` in the broker must name a declared field, since a pydantic
model raises AttributeError at runtime for an undeclared one.

The allowed names come from the model (model_fields plus attributes), so inherited
fields and properties are included by construction; a module binding the name
`settings` to something else would be a false positive.
"""

from __future__ import annotations

import ast
import pathlib

import broker
from broker.config import BrokerSettings

BROKER = pathlib.Path(broker.__file__).resolve().parent


def test_no_read_of_an_undeclared_setting():
    allowed = set(BrokerSettings.model_fields) | set(dir(BrokerSettings))
    assert "token_audience" in allowed and "store_config" in allowed

    dangling = []
    for path in sorted(BROKER.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if (isinstance(node, ast.Attribute)
                    and isinstance(node.value, ast.Name)
                    and node.value.id == "settings"
                    and node.attr not in allowed):
                dangling.append(f"{path.relative_to(BROKER)}:{node.lineno} settings.{node.attr}")

    assert not dangling, (
        "read of a setting BrokerSettings does not declare — pydantic raises "
        "AttributeError, so this throws wherever it runs:\n  " + "\n  ".join(dangling))
