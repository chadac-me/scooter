"""GitHub provider: a GitHub App (or PAT fallback) credential source, an http-proxy to api.github.com, the forge-proxy hosts, and the agent tool."""

from __future__ import annotations

from scooter_broker_lib.autolink import Link, rule
from scooter_broker_lib.forge import ForgeHosts, load_policy
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.transports.mcp_tools import McpTools

from .config import GitHubSettings
from .forge import GitHubDialect, api_base, forge_hosts
from .github_app import GitHubAppSource
from .mcp_tools import github_mcp_server


# Auto-link the PRs and issues an agent creates via the proxy; the create responses carry `html_url` and `title`.
_GITHUB_LINK_RULES = [
    rule(
        "POST", r"^(?:api/v3/)?repos/[^/]+/[^/]+/pulls/?$",
        lambda r: Link(source="github", resource_type="pr", url=r.get("html_url", ""), title=r.get("title")),
    ),
    rule(
        "POST", r"^(?:api/v3/)?repos/[^/]+/[^/]+/issues/?$",
        lambda r: Link(source="github", resource_type="issue", url=r.get("html_url", ""), title=r.get("title")),
    ),
]


# The same creates made by `gh` through the forge proxy, which uses GraphQL for most of them.
def _graphql_link(field: str, resource_type: str):
    def link(data: dict) -> Link | None:
        node = (data or {}).get(field) or {}
        url = node.get("url")
        return Link(source="github", resource_type=resource_type, url=url, title=node.get("title")) if url else None
    return link


_GITHUB_GRAPHQL_LINK_RULES = {
    "createPullRequest": _graphql_link("pullRequest", "pr"),
    "createIssue": _graphql_link("issue", "issue"),
}

@register_provider
def github() -> Provider:
    # Read at build time, like every provider factory.
    settings = GitHubSettings()
    upstream = api_base(settings.github_host)
    if settings.github_app_id and settings.github_app_private_key:
        credential = GitHubAppSource(
            app_id=settings.github_app_id,
            private_key=settings.github_app_private_key,
            installation_id=settings.github_app_installation_id,
            api_base=upstream,
        )
        enabled = True
    elif settings.github_token:
        credential = StaticTokenSource(token=settings.github_token)
        enabled = True
    else:
        credential = StaticTokenSource(token="")
        enabled = False

    return Provider(
        name="github",
        credential=credential,
        transports=[
            HttpProxy(
                upstream=upstream,
                link_rules=_GITHUB_LINK_RULES,
                agent_host_url=settings.agent_host_url,
            ),
            # The agent tool shares the proxy's upstream so the two cannot drift.
            McpTools(server=github_mcp_server(), upstream=upstream),
            ForgeHosts(
                hosts=forge_hosts(settings.github_host),
                dialect=GitHubDialect(),
                git_username="x-access-token",
                link_rules=_GITHUB_LINK_RULES,
                graphql_link_rules=_GITHUB_GRAPHQL_LINK_RULES,
            ),
        ],
        enabled=enabled,
        forge_policy=load_policy(settings.github_forge_policy),
    )
