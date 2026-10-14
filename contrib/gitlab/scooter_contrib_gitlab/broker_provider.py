"""GitLab provider: a PAT via the PRIVATE-TOKEN header, over http-proxy, git-credential and the agent tool."""

from __future__ import annotations

from .config import GitlabSettings
from .mcp_tools import gitlab_mcp_server
from scooter_broker_lib.autolink import Link, rule
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.git_credential import GitCredential
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.transports.mcp_tools import McpTools


# Auto-link the MRs and issues an agent creates via the proxy; the project id may be numeric or URL-encoded, and the path starts with `api/v4/` because the upstream is the bare host.
_GITLAB_LINK_RULES = [
    rule(
        "POST", r"^api/v4/projects/[^/]+/merge_requests/?$",
        lambda r: Link(source="gitlab", resource_type="mr", url=r.get("web_url", ""), title=r.get("title")),
    ),
    rule(
        "POST", r"^api/v4/projects/[^/]+/issues/?$",
        lambda r: Link(source="gitlab", resource_type="issue", url=r.get("web_url", ""), title=r.get("title")),
    ),
]


UPSTREAM = "https://gitlab.com"


@register_provider
def gitlab() -> Provider:
    # Read at build time, like every provider factory.
    settings = GitlabSettings()
    return Provider(
        name="gitlab",
        credential=StaticTokenSource(
            token=settings.gitlab_token, kind="header", header_name="PRIVATE-TOKEN"
        ),
        # Specific routes before the HttpProxy catch-all.
        transports=[
            GitCredential(host="gitlab.com"),
            # A bare-host upstream, so agents call the full API path through the proxy.
            HttpProxy(
                upstream=UPSTREAM,
                link_rules=_GITLAB_LINK_RULES,
                agent_host_url=settings.agent_host_url,
            ),
            McpTools(server=gitlab_mcp_server(), upstream=UPSTREAM),
        ],
        enabled=bool(settings.gitlab_token),
    )
