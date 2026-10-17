# Agent tools

The proxy gives the agent raw API access. **Tools** give it typed operations: a name, typed
arguments and a docstring, which the agent sees in its tool list. Use them for the
handful of actions the agent performs constantly or must get right, such as posting a
reply. Tools also return the real result. A failure comes back with its HTTP status
instead of being lost in a shell pipeline.

A contrib declares its tools on its own [FastMCP](https://gofastmcp.com) server, and the
broker serves them.

```python
# contrib/acme/scooter_contrib_acme/mcp_tools.py
"""Acme's agent tools."""

from __future__ import annotations

from fastmcp import FastMCP

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate

mcp = FastMCP(name="acme")


async def _has_acme_issue(ctx: ToolContext) -> bool:
    """Offer acme_comment only in conversations with an Acme issue attached."""
    return any(link.get("source") == "acme" for link in await ctx.links.list())


@gate(_has_acme_issue)
@mcp.tool
async def acme_comment(issue: str, body: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Post a comment on an Acme issue, as the Acme integration.

    `issue` is the key, like ENG-42. Use this to reply to the person who asked you for
    something on an Acme issue. A failure is returned with the real HTTP status; don't
    retry blindly.
    """
    if not body.strip():
        return ToolResult.error("`body` is required: the comment text.")
    response = await ctx.upstream.request("POST", f"v1/issues/{issue}/comments", json={"body": body})
    return ToolResult.from_upstream(response, success_text=f"Commented on {issue}.")


def acme_mcp_server() -> FastMCP:
    return mcp
```

Then add the server to the provider's transports:

```python
from scooter_broker_lib.transports.mcp_tools import McpTools

from .mcp_tools import acme_mcp_server

transports=[
    HttpProxy(upstream=UPSTREAM),
    McpTools(server=acme_mcp_server(), upstream=UPSTREAM),
],
```

## How a tool is put together

- **The schema comes from the type hints**, and the description from the docstring. The
  docstring is all the agent has to go on, so say when to use the tool and how it differs
  from similar ones.
- **`ctx: ToolContext = ToolContextDep`** is injected by the broker and kept out of the
  schema, so the agent can't forge it. It carries:
    - `ctx.identity`: the verified caller (conversation, owner, service account),
    - `ctx.upstream.request(method, path, json=…, params=…, headers=…)`: a call to the
      provider's upstream with the credential added, the same path `HttpProxy` uses,
    - `ctx.links.list()`: the resources attached to this conversation.
- **Return a `ToolResult`** (or a plain string):
    - `ToolResult.ok(text)` and `ToolResult.error(text)`.
    - `ToolResult.from_upstream(response, success_text=…)` turns an HTTP response into
      success or an error with the real status and body. Pass `ok_field_check=True` for
      APIs that report failure in a `200` body (like Slack's `{"ok": false}`), and
      `idempotent_errors=(…)` for errors that mean "already done".

## Naming

Tool names are **global** across all contribs, and the broker refuses to start if two
providers register the same one. So prefix with your contrib's name whenever another
contrib could offer the same capability: `acme_comment`, not `comment`. That's why there
are `brave_web_search` and `kagi_web_search` rather than one `web_search`, and both can
run at once.

## Gates

A tool **ships only when its provider is enabled**, so a deployment without an Acme token
has no Acme tools at all.

`@gate(predicate)` narrows that further, per conversation. Use it for reply tools: list
`acme_comment` only where an Acme resource is attached, so the agent isn't offered a tool
it can't use. Search-style tools need no gate.

`contrib/echo/scooter_contrib_echo/mcp_tools.py` demonstrates every one of these in a few
lines.

Next: [skills](skills.md).
