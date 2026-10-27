"""GitLab provider: a PAT via the PRIVATE-TOKEN header, over http-proxy, the forge proxy and the agent tool."""

from __future__ import annotations

from .config import GitlabSettings
from .forge import GitLabDialect, forge_hosts
from .mcp_tools import gitlab_mcp_server
from scooter_broker_lib.autolink import Link, rule
from scooter_broker_lib.forge import ForgeHosts, load_policy
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
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


@register_provider
def gitlab() -> Provider:
    # Read at build time, like every provider factory.
    settings = GitlabSettings()
    upstream = f"https://{settings.gitlab_host}"
    return Provider(
        name="gitlab",
        credential=StaticTokenSource(
            token=settings.gitlab_token, kind="header", header_name="PRIVATE-TOKEN"
        ),
        transports=[
            # A bare-host upstream, so agents call the full API path through the proxy.
            HttpProxy(
                upstream=upstream,
                link_rules=_GITLAB_LINK_RULES,
                agent_host_url=settings.agent_host_url,
            ),
            McpTools(server=gitlab_mcp_server(), upstream=upstream),
            # One host for git and the API; the REST link rules already match `api/v4/...` paths.
            ForgeHosts(
                hosts=forge_hosts(settings.gitlab_host),
                dialect=GitLabDialect(),
                git_username="oauth2",
                link_rules=_GITLAB_LINK_RULES,
            ),
        ],
        enabled=bool(settings.gitlab_token),
        forge_policy=load_policy(settings.gitlab_forge_policy),
    )
