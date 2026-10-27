"""Auto-linking: a PR, MR or issue the agent creates through the http-proxy is associated with its conversation.

A provider declares LinkRules for its create endpoints; when a matching proxied
request returns 2xx, the created resource is POSTed to the agent-host's
/conversations/{id}/links. Best-effort throughout, so a link that cannot be built
or posted never breaks the proxied call.
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Callable
from dataclasses import dataclass

import httpx

from scooter_lib.logging_config import format_error
from scooter_lib.svcauth import TokenSource

logger = logging.getLogger(__name__)

# The broker's router token; absent outside a cluster.
_router_token = TokenSource(os.environ.get("SCOOTER_ROUTER_TOKEN_PATH", "/var/run/secrets/scooter-router/token"))


def router_headers() -> dict[str, str]:
    """Auth headers for a call to the router, empty when no token can be read."""
    try:
        return _router_token.headers()
    except OSError as e:
        logger.warning("router token unreadable; calling without it", extra={"error": format_error(e)})
        return {}


@dataclass(frozen=True)
class Link:
    """A resource to associate with a conversation, in the agent-host's POST /conversations/{id}/links shape."""

    source: str          # "github" | "gitlab" | "jira"
    resource_type: str   # "pr" | "mr" | "issue"
    url: str             # the human-visitable URL
    title: str | None = None


@dataclass(frozen=True)
class LinkRule:
    """Match a proxied create request by method and path regex (without the /{provider}/ prefix) and extract the created resource from its response."""

    method: str
    path_pattern: re.Pattern[str]
    extract: Callable[[dict], Link | None]

    def matches(self, method: str, path: str) -> bool:
        return method.upper() == self.method.upper() and self.path_pattern.search(path) is not None


def rule(method: str, path_regex: str, extract: Callable[[dict], Link | None]) -> LinkRule:
    return LinkRule(method=method, path_pattern=re.compile(path_regex), extract=extract)


def _links_url(agent_host_url: str, conversation_id: str) -> str:
    return f"{agent_host_url.rstrip('/')}/conversations/{conversation_id}/links"


async def post_link(agent_host_url: str, conversation_id: str, link: Link) -> None:
    """POST a link to the agent-host, best-effort and never raising."""
    if not agent_host_url or not conversation_id:
        return
    payload = {
        "source": link.source,
        "resourceType": link.resource_type,
        "url": link.url,
        "title": link.title,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(_links_url(agent_host_url, conversation_id), json=payload, headers=router_headers())
        if resp.status_code >= 300:
            logger.warning(
                "auto-link POST /links failed",
                extra={
                    "conversation_id": conversation_id,
                    "status": resp.status_code,
                    "source": link.source,
                    "resource_type": link.resource_type,
                    "url": link.url,
                },
            )
        else:
            logger.info(
                "auto-linked resource to conversation",
                extra={
                    "conversation_id": conversation_id,
                    "status": resp.status_code,
                    "source": link.source,
                    "resource_type": link.resource_type,
                    "url": link.url,
                },
            )
    except httpx.HTTPError as e:
        logger.warning(
            "auto-link POST /links errored",
            extra={
                "conversation_id": conversation_id,
                "source": link.source,
                "resource_type": link.resource_type,
                "url": link.url,
                "error": format_error(e),
            },
        )


async def create_link(agent_host_url: str, conversation_id: str, link: Link) -> None:
    """Attach a link to the conversation, raising on failure."""
    if not agent_host_url:
        raise RuntimeError("agent-host URL not configured (AGENT_HOST_URL)")
    if not conversation_id:
        raise RuntimeError("no conversation for this identity — cannot attach a link")
    payload = {
        "source": link.source,
        "resourceType": link.resource_type,
        "url": link.url,
        "title": link.title,
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(_links_url(agent_host_url, conversation_id), json=payload, headers=router_headers())
        resp.raise_for_status()


async def list_links(agent_host_url: str, conversation_id: str) -> list[dict]:
    """The conversation's current links from the agent-host."""
    if not agent_host_url or not conversation_id:
        return []
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(_links_url(agent_host_url, conversation_id), headers=router_headers())
        resp.raise_for_status()
        data = resp.json()
    return data.get("links", []) if isinstance(data, dict) else []
