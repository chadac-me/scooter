"""Slack's resource shapes, registered into `scooter_webhooks_lib.resources`: a Slack id has one spelling, so only type aliases are needed."""

from __future__ import annotations

from scooter_webhooks_lib.resources import ResourceShapes, register_resource_shapes

register_resource_shapes(
    "slack",
    ResourceShapes(type_aliases={"message": "thread", "thread": "thread"}),
)
