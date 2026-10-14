"""Web search: the shared half of a search contrib's `<provider>_web_search` tool.

Providers differ in the request they make and the body they unpack; the result
format, the cap and the outcomes live here. A failure carries the real status
verbatim, and "no results" is a success that names the provider, because an agent
told "no results" retries while one told "HTTP 401" reports a bad key.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from .mcp import ToolResult

if TYPE_CHECKING:
    import httpx

# The cap the agent is given, not a provider's page size.
MAX_RESULTS = 10


@dataclass(frozen=True)
class SearchHit:
    """One result, normalized across providers; `url` is required because a hit the agent cannot follow is not a result."""

    title: str
    url: str
    snippet: str | None = None


def upstream_failure(response: "httpx.Response", *, provider: str) -> ToolResult | None:
    """`None` if the search call succeeded, else the failure to report verbatim, naming the provider."""
    if 200 <= response.status_code < 300:
        return None
    return ToolResult.error(
        f"web search FAILED via {provider} (HTTP {response.status_code}). "
        f"The service returned:\n{response.text}"
    )


def search_response(
    response: "httpx.Response", *, provider: str
) -> tuple[dict[str, Any], ToolResult | None]:
    """Decode a search response into `(body, failure)`, of which exactly one is meaningful.

    A 200 whose body is not JSON at all is a failure (a proxy error page or captive
    portal answered), while JSON that is not an object is an empty result set.
    """
    failure = upstream_failure(response, provider=provider)
    if failure is not None:
        return {}, failure
    if not response.content:
        return {}, None
    try:
        body = response.json()
    except (ValueError, json.JSONDecodeError):
        return {}, ToolResult.error(
            f"web search FAILED via {provider}: HTTP {response.status_code} with a body "
            f"that is not JSON, so nothing answered as the search API. It returned:\n"
            f"{response.text[:500]}"
        )
    return (body if isinstance(body, dict) else {}), None


def hits_from(rows: Iterable[dict], *, title: str, url: str, snippet: str) -> list[SearchHit]:
    """Unpack a provider's result rows by field name, dropping any row with no url and using the url as a missing title."""
    hits: list[SearchHit] = []
    for row in rows:
        link = (row.get(url) or "").strip()
        if not link:
            continue
        hits.append(SearchHit(title=(row.get(title) or link), url=link, snippet=row.get(snippet)))
        if len(hits) >= MAX_RESULTS:
            break
    return hits


def search_result(hits: Sequence[SearchHit], *, query: str, provider: str) -> ToolResult:
    """Render hits as the agent-facing text block, one `- title (url)` per line with the snippet beneath."""
    if not hits:
        # Success, not an error: the query ran and the web had nothing.
        return ToolResult.ok(f'No results for "{query}" (via {provider}).')
    lines = [f'Results for "{query}":']
    for hit in hits[:MAX_RESULTS]:
        lines.append(f"- {hit.title} ({hit.url})")
        if hit.snippet:
            lines.append(f"  {hit.snippet}")
    return ToolResult.ok("\n".join(lines))
