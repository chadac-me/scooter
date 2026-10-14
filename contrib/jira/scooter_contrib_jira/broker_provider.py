"""Jira provider: Atlassian OAuth over http-proxy and the agent tool."""

from __future__ import annotations

from .config import JiraSettings
from scooter_broker_lib.autolink import Link, rule
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from .atlassian_oauth import AtlassianOAuthSource
from .mcp_tools import jira_mcp_server
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.transports.mcp_tools import McpTools


def _jira_issue_link(r: dict) -> Link | None:
    settings = JiraSettings()
    # The create-issue response carries {id, key, self}; the site's /browse/{KEY} is preferred when configured.
    key = r.get("key")
    if not key:
        return None
    site = settings.jira_site_url.rstrip("/")
    url = f"{site}/browse/{key}" if site else r.get("self", "")
    return Link(source="jira", resource_type="issue", url=url, title=key)


# create-issue is POST /rest/api/{2,3}/issue; /issue/bulk is excluded.
_JIRA_LINK_RULES = [
    rule("POST", r"^rest/api/[23]/issue/?$", _jira_issue_link),
]


@register_provider
def jira() -> Provider:
    # Read at build time, like every provider factory.
    settings = JiraSettings()
    cloud_id = settings.atlassian_cloud_id
    upstream = f"https://api.atlassian.com/ex/jira/{cloud_id}"
    return Provider(
        name="jira",
        credential=AtlassianOAuthSource(
            client_id=settings.atlassian_client_id,
            client_secret=settings.atlassian_client_secret,
            cloud_id=cloud_id,
        ),
        transports=[
            HttpProxy(
                upstream=upstream,
                link_rules=_JIRA_LINK_RULES,
                agent_host_url=settings.agent_host_url,
            ),
            McpTools(server=jira_mcp_server(), upstream=upstream),
        ],
        enabled=bool(settings.atlassian_client_id and cloud_id),
    )
