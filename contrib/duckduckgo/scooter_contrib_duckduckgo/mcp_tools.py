"""DuckDuckGo's agent tool, `duckduckgo_web_search`: keyless and best-effort.

Reads DDG's no-JavaScript results page, since DDG has no results API. The browser
User-Agent is required because the page refuses a programmatic one, and a page with
no hits is a failure unless DDG itself said "no results", because rate-limiting and
a restyle both arrive as an empty 200.
"""

from __future__ import annotations

from fastmcp import FastMCP

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult
from scooter_broker_lib.search import search_result, upstream_failure

from .html_results import classify, hits_from_html

mcp = FastMCP(name="duckduckgo")

PROVIDER = "duckduckgo"
UPSTREAM = "https://html.duckduckgo.com"
SEARCH_PATH = "html/"

# The no-JS page refuses a programmatic user agent.
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

# Region-neutral, so DDG does not localize by egress IP.
REGION = "wt-wt"


@mcp.tool
async def duckduckgo_web_search(query: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Search the web with DuckDuckGo and get ranked results (title, URL, snippet).

    Needs no API key, so a deployment may have this and nothing else. It is also the
    least reliable search tool here: it reads DuckDuckGo's public results page, so it can
    be rate-limited — reported as a FAILURE, not as an empty web. If that happens prefer
    another `*_web_search` tool if your list has one, or `web_fetch` on a URL you already
    know; repeating the query will be refused too.
    """
    # Not attachment-gated; the gate is `duckduckgo_enabled` in broker_provider.py.
    text = query.strip()
    if not text:
        return ToolResult.error("`query` is required — pass the text to search for.")

    response = await ctx.upstream.request(
        "GET",
        SEARCH_PATH,
        params={"q": text, "kl": REGION},
        headers={"User-Agent": BROWSER_USER_AGENT, "Accept": "text/html"},
    )
    failure = upstream_failure(response, provider=PROVIDER)
    if failure is not None:
        return failure

    page = response.text
    hits = hits_from_html(page)
    if hits:
        return search_result(hits, query=text, provider=PROVIDER)

    outcome = classify(page)
    if outcome == "empty":
        return search_result([], query=text, provider=PROVIDER)
    if outcome == "blocked":
        return ToolResult.error(
            f"duckduckgo_web_search FAILED: DuckDuckGo served its bot-check page instead "
            f'of results for "{text}". This provider reads the keyless HTML page, so it '
            "is rate-limited per source address and this deployment has hit the limit. "
            "Retrying the same query will not help — use another search tool if one is "
            "listed, or `web_fetch` on a URL you already know, and say that search was "
            "rate-limited."
        )
    return ToolResult.error(
        f'duckduckgo_web_search FAILED: DuckDuckGo answered for "{text}" with a page '
        "holding neither results nor its own 'no results' notice, which means the page's "
        "shape changed and this provider can no longer read it. Reported as a failure "
        "rather than as an empty result set ON PURPOSE — the web is not empty, this "
        "scraper is broken. Worth reporting to whoever runs this deployment."
    )


def duckduckgo_mcp_server() -> FastMCP:
    """The server the provider factory hands to `McpTools`."""
    return mcp
