"""The /mcp endpoint: authenticate, establish the per-call context, let fastmcp serve.

`authenticate_mcp` produces an Identity bound to the presented credentials; each enabled
provider's `McpTools` server is mounted namespace-less so tool names stay flat (the skills
and ui/src/toolCallView.ts match on them); and a per-provider middleware establishes the
`ToolContext` for a call and applies the attachment gate when listing. The endpoint is
stateless because the broker runs several replicas behind a load balancer.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from fastmcp.server.middleware import Middleware

from scooter_broker_lib.autolink import list_links
from scooter_broker_lib.forge import DENY_HEADER, api_forge_request, denial_message, enforce
from scooter_broker_lib.mcp import ToolContext, collect_mcp_servers, gate_for, tool_context
from scooter_broker_lib.types import Identity, Provider
from scooter_lib.logging_config import format_error

logger = logging.getLogger(__name__)

# The ASGI scope key where the auth middleware parks the Identity for the tool middleware.
SCOPE_IDENTITY = "scooter_identity"


class _Upstream:
    """Issue a request to a provider's upstream with its credential injected the same way HttpProxy does."""

    def __init__(self, provider: Provider, identity: Identity, upstream: str) -> None:
        self._provider = provider
        self._identity = identity
        self._upstream = (upstream or "").rstrip("/")

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Any | None = None,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        if not self._upstream:
            raise RuntimeError(
                f"provider {self._provider.name!r} declared MCP tools with no `upstream`; "
                "set McpTools(upstream=...)"
            )
        url = f"{self._upstream}/{path.lstrip('/')}"
        async with httpx.AsyncClient(timeout=30) as client:
            outbound = client.build_request(
                method.upper(), url, json=json, params=params, headers=headers
            )
            forge_req = api_forge_request(
                self._provider, self._identity, via="mcp",
                method=outbound.method, url=outbound.url, body=outbound.content,
            )
            if forge_req is not None:
                decision = await enforce(self._provider.forge_policy, forge_req)
                if not decision.allowed:
                    # A response, not an exception, so tools surface it the way they surface any upstream 403.
                    return httpx.Response(
                        403,
                        json={"message": denial_message(decision)},
                        headers={DENY_HEADER: decision.reason or "denied"},
                        request=outbound,
                    )
            if self._provider.credential is not None:
                cred = await self._provider.credential.get(self._identity)
                cred.inject(outbound)
            return await client.send(outbound)


class _Links:
    """The conversation's links, read from the agent-host and cached for one call since every gate asks for them."""

    def __init__(self, agent_host_url: str, conversation_id: str) -> None:
        self._agent_host_url = agent_host_url
        self._conversation_id = conversation_id
        self._cached: list[dict[str, Any]] | None = None

    async def list(self) -> list[dict[str, Any]]:
        if self._cached is None:
            try:
                links = await list_links(self._agent_host_url, self._conversation_id)
                # The resource map is appended so a real link always wins by position.
                self._cached = links + await self._resource_map()
            except httpx.HTTPError as exc:
                # Degrade to "nothing is attached" rather than crash tools/list.
                logger.warning(
                    "could not read conversation links; gated tools will be absent",
                    extra={"conversation_id": self._conversation_id, "error": format_error(exc)},
                )
                self._cached = []
        return self._cached

    async def _resource_map(self) -> list[dict[str, Any]]:
        """The webhooks conversation_map rows shaped as links, read via the agent-host's resource-map endpoint, with `resource_id` in `url` because each provider's `parse_*_resource_id` accepts either form."""
        if not self._agent_host_url or not self._conversation_id:
            return []
        url = f"{self._agent_host_url.rstrip('/')}/conversations/{self._conversation_id}/resource-map"
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(url)
                response.raise_for_status()
                mappings = (response.json() or {}).get("mappings") or []
        except (httpx.HTTPError, ValueError) as exc:
            # Best-effort: a failure means no fallback target, not a broken tool call.
            logger.warning(
                "could not read the conversation resource-map; using links alone",
                extra={"conversation_id": self._conversation_id, "error": format_error(exc)},
            )
            return []
        rows: list[dict[str, Any]] = []
        for mapping in mappings:
            if not isinstance(mapping, dict):
                continue
            source = mapping.get("source") or ""
            ref: dict[str, Any] = {}
            if source == "slack":
                channel = mapping.get("slackChannel")
                if channel:
                    ref = {"channel": channel, "threadTs": mapping.get("slackTs")}
            rows.append({
                "source": source,
                "resourceType": mapping.get("resourceType") or "",
                "url": mapping.get("resourceId") or "",
                "ref": ref,
            })
        return rows


def _identity_from_scope() -> Identity | None:
    """The Identity the auth middleware stashed, via fastmcp's request accessor."""
    from fastmcp.server.dependencies import get_http_request

    try:
        request = get_http_request()
    except RuntimeError:
        return None
    return request.scope.get(SCOPE_IDENTITY)


class ProviderToolMiddleware(Middleware):
    """Establish the ToolContext for one provider's tools and apply their gates; it must subclass fastmcp's `Middleware`, since the base provides the dispatch to `on_list_tools` / `on_call_tool`."""

    def __init__(self, provider: Provider, upstream: str, agent_host_url: str) -> None:
        super().__init__()
        self.provider = provider
        self.upstream = upstream
        self.agent_host_url = agent_host_url

    def _context(self, identity: Identity) -> ToolContext:
        return ToolContext(
            identity=identity,
            provider=self.provider,
            upstream=_Upstream(self.provider, identity, self.upstream),
            links=_Links(self.agent_host_url, identity.conversation_id),
        )

    async def on_list_tools(self, context, call_next):
        """The attachment gate: a provider's gated tool is offered only when that provider is linked to this conversation."""
        tools = await call_next(context)
        identity = _identity_from_scope()
        if identity is None:
            return tools
        ctx = self._context(identity)
        kept = []
        for tool in tools:
            gate = gate_for(getattr(tool, "name", "") or "")
            if gate is None:
                kept.append(tool)
                continue
            try:
                with tool_context(ctx):
                    allowed = await gate(ctx)
            except Exception as exc:
                # A gate that throws means "not attached", never "attached".
                logger.warning(
                    "tool gate FAILED; leaving the tool unlisted",
                    extra={
                        "tool": getattr(tool, "name", "?"),
                        "provider": self.provider.name,
                        "conversation_id": identity.conversation_id,
                        "error": format_error(exc),
                    },
                )
                continue
            if allowed:
                kept.append(tool)
        return kept

    async def on_call_tool(self, context, call_next):
        identity = _identity_from_scope()
        if identity is None:
            # Unreachable through the mounted app, since auth runs first.
            raise RuntimeError("no verified identity for this tool call")
        with tool_context(self._context(identity)):
            return await call_next(context)


class _AuthMiddleware:
    """Authenticate every request to the mounted MCP app and stash the Identity, as pure ASGI because BaseHTTPMiddleware would buffer the streamed response."""

    def __init__(self, app: ASGIApp, authenticate) -> None:
        self.app = app
        self.authenticate = authenticate
        # The wrapped app's lifespan is re-exposed so the broker's lifespan can compose it,
        # since mounting an ASGI app does not run its lifespan.
        self.lifespan = getattr(app, "lifespan", None)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope, receive=receive)
        try:
            identity = await self.authenticate(request)
        except HTTPException as exc:
            await JSONResponse({"detail": exc.detail}, status_code=exc.status_code)(
                scope, receive, send
            )
            return
        scope[SCOPE_IDENTITY] = identity
        await self.app(scope, receive, send)


async def assert_tool_names_unique(providers: list[Provider]) -> None:
    """Fail startup if two providers contribute a tool of the same name, since tool names are flat and nothing but mount order would arbitrate a collision."""
    owner_of: dict[str, str] = {}
    for provider, server in collect_mcp_servers(providers):
        # The gates need a conversation, and a gated-out tool must still count.
        for tool in await server.list_tools(run_middleware=False):
            owner = owner_of.get(tool.name)
            if owner is not None and owner != provider.name:
                raise RuntimeError(
                    f"two providers contribute a tool named {tool.name!r}: {owner!r} and "
                    f"{provider.name!r}. Tool names are flat, so this cannot be resolved "
                    "by mount order — rename one of them after its provider (the search "
                    "contribs do: `brave_web_search`, `kagi_web_search`)."
                )
            owner_of[tool.name] = provider.name


def create_mcp_app(providers: list[Provider], *, authenticate, agent_host_url: str = "") -> ASGIApp:
    """The ASGI app serving POST /mcp with auth in front of it, to be mounted rather than included so fastmcp's streaming stays intact."""
    from fastmcp import FastMCP

    parent = FastMCP(name="scooter-broker")

    mounted = collect_mcp_servers(providers)
    for provider, server in mounted:
        upstream = ""
        for transport in provider.transports:
            candidate = getattr(transport, "upstream", "")
            if candidate:
                upstream = candidate
                break
        # Bound to the provider's own server, so no tool-name-to-provider map is needed.
        server.add_middleware(ProviderToolMiddleware(provider, upstream, agent_host_url))
        parent.mount(server)

    logger.info(
        "assembled MCP tool servers",
        extra={"providers": sorted({p.name for p, _ in mounted})},
    )

    app = parent.http_app(path="/", stateless_http=True)
    return _AuthMiddleware(app, authenticate)
