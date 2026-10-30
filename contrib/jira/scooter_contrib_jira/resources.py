"""Jira's resource shapes, registered into `scooter_webhooks_lib.resources`: a browse URL and a bare issue key name the same issue, and a bare key is never widened because the site is not in it."""

from __future__ import annotations

import re

from scooter_webhooks_lib.resources import (
    ResourceShapes,
    load_type_aliases,
    register_resource_shapes,
)

_JIRA_URL_RE = re.compile(r"^https?://[^/]+/browse/([A-Za-z][A-Za-z0-9_]*-\d+)(?:[/?#].*)?$")


def _id_variants(_resource_type: str, resource_id: str) -> list[str]:
    url = _JIRA_URL_RE.match(resource_id)
    return [resource_id, url.group(1).upper()] if url else [resource_id]


register_resource_shapes(
    "jira",
    ResourceShapes(
        type_aliases=load_type_aliases(__package__),
        id_variants=_id_variants,
    ),
)
