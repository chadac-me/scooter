"""Datadog provider: two-key header auth over http-proxy only.

Proxies /datadog/* to https://api.<site> with both keys injected; enabled iff
both keys are configured.
"""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.transports.http_proxy import HttpProxy

from .config import DatadogSettings
from .datadog_keys import DatadogKeysSource


@register_provider
def datadog() -> Provider:
    # Read at build time, like every provider factory.
    settings = DatadogSettings()
    site = (settings.datadog_site or "datadoghq.com").strip().lstrip(".")
    return Provider(
        name="datadog",
        credential=DatadogKeysSource(
            api_key=settings.datadog_api_key,
            app_key=settings.datadog_app_key,
        ),
        transports=[HttpProxy(upstream=f"https://api.{site}")],
        enabled=bool(settings.datadog_api_key and settings.datadog_app_key),
    )
