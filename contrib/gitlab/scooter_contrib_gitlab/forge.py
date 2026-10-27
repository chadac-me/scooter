"""GitLab's shape for the forge proxy: its host and how its API names projects."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import unquote

from scooter_broker_lib.forge import ForgeHost

_API_PROJECT = re.compile(r"^/api/v4/projects/(?P<id>[^/]+)")


@dataclass(frozen=True)
class GitLabDialect:
    def api_repo(self, path: str) -> str | None:
        m = _API_PROJECT.match(path if path.startswith("/") else "/" + path)
        return unquote(m.group("id")) if m else None

    def is_graphql(self, path: str) -> bool:
        return "/" + path.lstrip("/") == "/api/graphql"


def forge_hosts(host: str) -> list[ForgeHost]:
    return [ForgeHost(host, git=True, api_prefixes=("/api/",))]
