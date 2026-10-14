"""Importing the app must register the in-tree resource shapes, which happens by import side effect and would otherwise fail silently.

Asserted as a subset because the built service also ships whatever contribs the image carries.
"""

from __future__ import annotations

from scooter_webhooks_lib import resources

IN_TREE_SHAPES = {"jira"}


def test_importing_the_app_registers_every_in_tree_resource_shape():
    import webhooks.app  # noqa: F401

    assert IN_TREE_SHAPES <= set(resources.registered_sources())
