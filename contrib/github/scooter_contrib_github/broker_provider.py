"""GitHub provider: a GitHub App (or PAT fallback) credential source, an http-proxy to api.github.com, a git-credential helper for github.com, and the agent tool."""

from __future__ import annotations

from scooter_broker_lib.autolink import Link, rule
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.git_credential import GitCredential
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.transports.mcp_tools import McpTools

from .config import GitHubSettings
from .github_app import GitHubAppSource
from .mcp_tools import github_mcp_server


# Auto-link the PRs and issues an agent creates via the proxy; the create responses carry `html_url` and `title`.
_GITHUB_LINK_RULES = [
    rule(
        "POST", r"^repos/[^/]+/[^/]+/pulls/?$",
        lambda r: Link(source="github", resource_type="pr", url=r.get("html_url", ""), title=r.get("title")),
    ),
    rule(
        "POST", r"^repos/[^/]+/[^/]+/issues/?$",
        lambda r: Link(source="github", resource_type="issue", url=r.get("html_url", ""), title=r.get("title")),
    ),
]


UPSTREAM = "https://api.github.com"


@register_provider
def github() -> Provider:
    # Read at build time, like every provider factory.
    settings = GitHubSettings()
    if settings.github_app_id and settings.github_app_private_key:
        credential = GitHubAppSource(
            app_id=settings.github_app_id,
            private_key=settings.github_app_private_key,
            installation_id=settings.github_app_installation_id,
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
        # FastAPI matches routes in registration order, so git-credentials must precede the HttpProxy catch-all.
        transports=[
            GitCredential(host="github.com", username="x-access-token"),
            HttpProxy(
                upstream=UPSTREAM,
                link_rules=_GITHUB_LINK_RULES,
                agent_host_url=settings.agent_host_url,
            ),
            # The agent tool shares the proxy's upstream so the two cannot drift.
            McpTools(server=github_mcp_server(), upstream=UPSTREAM),
        ],
        enabled=enabled,
    )
