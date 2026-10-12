"""Echo's agent tools, the worked example of the contrib tool surface.

Tools are declared on the contrib's own `FastMCP` server with `@mcp.tool`, with the
input schema from the type hints and the description from the docstring; the broker
mounts the server namespace-less. `ctx: ToolContext = ToolContextDep` is injected and
carries the verified caller, a credential-injecting upstream caller and the
conversation's links. Each tool demonstrates one thing a real integration needs:
typed arguments, the verified caller, an upstream call, and the attachment gate.
"""

from __future__ import annotations

from fastmcp import FastMCP

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate

# The link source that gates `echo_attached`, as recorded by `agent-broker link add --source`.
LINK_SOURCE = "echo"

mcp = FastMCP(name="echo")


async def _has_echo_link(ctx: ToolContext) -> bool:
    """The attachment gate: whether an `echo` resource is attached to this conversation (a gate that raises counts as not attached)."""
    return any(link.get("source") == LINK_SOURCE for link in await ctx.links.list())


@mcp.tool
async def echo_say(message: str, ctx: ToolContext = ToolContextDep) -> str:
    """Echo a message back.

    The reference tool for Scooter's contrib MCP surface — it proves the path from the
    agent through the broker to a contrib and back, and is useful for nothing else.
    """
    # Validation beyond what the type system can say is still the tool's job.
    text = message.strip()
    if not text:
        return "`message` is required — pass the text to echo."
    return f"echo: {text}"


@mcp.tool
async def echo_whoami(ctx: ToolContext = ToolContextDep) -> str:
    """Report the conversation, owner and service account the broker VERIFIED for this
    call.

    Use it to confirm a tool call is scoped to the conversation you expect; the values
    come from a signed token, not from anything the agent supplied.
    """
    identity = ctx.identity
    return "\n".join(
        [
            f"conversation: {identity.conversation_id}",
            # `owner` rides in the conversation token, so a sandbox's own SA carries none.
            f"owner: {identity.owner or '(unknown — a sandbox SA carries none)'}",
            f"service account: {identity.service_account}",
            f"namespace: {identity.namespace}",
        ]
    )


@mcp.tool
async def echo_upstream(path: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """GET a path on this provider's upstream API, with the provider's credential
    injected by the broker.

    Demonstrates a typed tool over the same call the raw proxy route makes. A failure
    is returned to you with the real HTTP status and the upstream body verbatim — do
    NOT retry blindly on an error.
    """
    target = path.strip().lstrip("/")
    if not target:
        return ToolResult.error("`path` is required — the upstream path to GET.")
    # The same credential-injecting path HttpProxy uses, so the agent never holds the secret.
    response = await ctx.upstream.request("GET", target)
    return ToolResult.from_upstream(
        response,
        success_text=f"GET {target} returned {response.status_code}.",
        # For an API that reports logical failure with a 200 body.
        ok_field_check=True,
        # Logical errors meaning the desired state already exists, which counts as success.
        idempotent_errors=("already_done",),
    )


@gate(_has_echo_link)
@mcp.tool
async def echo_attached(ctx: ToolContext = ToolContextDep) -> str:
    """List the `echo` resources linked to THIS conversation.

    Offered only when at least one is attached — the attachment gate, so you are never
    shown a tool for a resource that is not there.
    """
    links = [link for link in await ctx.links.list() if link.get("source") == LINK_SOURCE]
    urls = ", ".join(str(link.get("url")) for link in links) or "(none)"
    return f"this conversation's {LINK_SOURCE} links: {urls}"


def echo_mcp_server() -> FastMCP:
    """The server the provider factory hands to `McpTools`."""
    return mcp
