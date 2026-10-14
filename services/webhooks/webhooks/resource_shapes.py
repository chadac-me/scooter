"""The in-tree providers' resource-identity knowledge: how a URL decomposes and which type spellings mean the same thing, registered with `scooter_webhooks_lib.resources` as an import side effect."""

from __future__ import annotations

import re

from scooter_webhooks_lib.resources import (
    ResourceShapes,
    canonical_resource_type,
    register_resource_shapes,
)

_GITHUB_SHORT_RE = re.compile(r"^([^/\s]+)/([^/#\s]+)#(\d+)$")
_GITHUB_URL_RE = re.compile(
    r"^https?://[^/]+/([^/\s]+)/([^/\s]+)/(pull|pulls|issues|issue)/(\d+)(?:[/?#].*)?$"
)
_JIRA_URL_RE = re.compile(r"^https?://[^/]+/browse/([A-Za-z][A-Za-z0-9_]*-\d+)(?:[/?#].*)?$")


def _jira_id_variants(_resource_type: str, resource_id: str) -> list[str]:
    url = _JIRA_URL_RE.match(resource_id)
    return [resource_id, url.group(1).upper()] if url else [resource_id]


register_resource_shapes(
    "jira",
    ResourceShapes(
        type_aliases={"ticket": "issue", "issue": "issue"},
        id_variants=_jira_id_variants,
    ),
)
