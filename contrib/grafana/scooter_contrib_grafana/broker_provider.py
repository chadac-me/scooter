"""Grafana provider: a bearer token over http-proxy only.

Proxies /grafana/* to the configured stack with the service-account token
injected; enabled iff both the stack URL and the token are configured.
"""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy

from .config import GrafanaSettings


@register_provider
def grafana() -> Provider:
    # Read at build time, like every provider factory.
    settings = GrafanaSettings()
    url = (settings.grafana_url or "").strip().rstrip("/")
    return Provider(
        name="grafana",
        # Grafana service-account tokens are plain bearer tokens.
        credential=StaticTokenSource(token=settings.grafana_token),
        transports=[HttpProxy(upstream=url)],
        enabled=bool(url and settings.grafana_token),
    )
