"""Datadog settings, owned by this contrib."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class DatadogSettings(ScooterBaseSettings):
    datadog_api_key: str = ""
    datadog_app_key: str = ""
    # Region-specific (datadoghq.com, datadoghq.eu, us3/us5.datadoghq.com, ap1.datadoghq.com, ddog-gov.com).
    datadog_site: str = "datadoghq.com"
