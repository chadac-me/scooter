"""Brave's agent tool, `brave_web_search`.

The key is a header injected by the broker, never a query param that would land in
access logs; the tool is named for its provider so sibling search contribs can be
enabled at the same time.
"""

from __future__ import annotations

from fastmcp import FastMCP

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult
from scooter_broker_lib.search import MAX_RESULTS, hits_from, search_response, search_result

mcp = FastMCP(name="brave")

PROVIDER = "brave"
UPSTREAM = "https://api.search.brave.com"
# The plain results endpoint.
SEARCH_PATH = "res/v1/web/search"


@mcp.tool
async def brave_web_search(query: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Search the web with Brave and get ranked results (title, URL, snippet).

    An independent index (Brave's own crawl), good for finding a fact and for picking a
    canonical URL to pass to `web_fetch`. If your tool list has other `*_web_search`
    tools they are other indexes over the same web: use ONE, and only try another if
    this one fails or returns nothing useful.

    A failure is returned to you with the real HTTP status and the provider's body
    verbatim — a 401 or 429 means this deployment's search key is bad or out of quota,
    so report it rather than retrying the query.
    """
    # Not attachment-gated; the gate is the provider's `enabled` in broker_provider.py.
    text = query.strip()
    if not text:
        return ToolResult.error("`query` is required — pass the text to search for.")

    response = await ctx.upstream.request(
        "GET",
        SEARCH_PATH,
        params={"q": text, "count": MAX_RESULTS},
        headers={"Accept": "application/json"},
    )
    body, failure = search_response(response, provider=PROVIDER)
    if failure is not None:
        return failure

    rows = (body.get("web") or {}).get("results") or []
    return search_result(
        hits_from(rows, title="title", url="url", snippet="description"),
        query=text,
        provider=PROVIDER,
    )


def brave_mcp_server() -> FastMCP:
    """The server the provider factory hands to `McpTools`."""
    return mcp
