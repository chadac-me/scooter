"""GitHub's resource shapes: which ids and type spellings name the same PR or issue, registered into `scooter_webhooks_lib.resources`."""

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


def _id_variants(resource_type: str, resource_id: str) -> list[str]:
    """`owner/repo#N` <-> `https://github.com/owner/repo/(pull|issues)/N`."""
    short = _GITHUB_SHORT_RE.match(resource_id)
    if short:
        owner, repo, number = short.groups()
        path = "issues" if canonical_resource_type("github", resource_type) == "issue" else "pull"
        return [resource_id, f"https://github.com/{owner}/{repo}/{path}/{number}"]
    url = _GITHUB_URL_RE.match(resource_id)
    if url:
        owner, repo, _kind, number = url.groups()
        return [resource_id, f"{owner}/{repo}#{number}"]
    return [resource_id]


register_resource_shapes(
    "github",
    ResourceShapes(
        type_aliases={"pr": "pull_request", "pull_request": "pull_request", "issue": "issue"},
        id_variants=_id_variants,
    ),
)
