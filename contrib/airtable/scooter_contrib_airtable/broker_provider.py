"""Airtable provider: a personal access token over http-proxy only.

Proxies /airtable/* to Airtable's fixed API host with the PAT injected as a bearer
header; enabled iff a token is configured.
"""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy

from .config import AirtableSettings


@register_provider
def airtable() -> Provider:
    # Read at build time, once per create_app().
    settings = AirtableSettings()
    token = (settings.airtable_token or "").strip()
    return Provider(
        name="airtable",
        # Airtable PATs are plain bearer tokens.
        credential=StaticTokenSource(token=token),
        transports=[HttpProxy(upstream="https://api.airtable.com")],
        enabled=bool(token),
    )
