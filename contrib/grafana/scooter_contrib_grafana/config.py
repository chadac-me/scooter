"""Grafana settings, owned by this contrib."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class GrafanaSettings(ScooterBaseSettings):
    # The stack's base URL; a trailing slash is stripped by the provider.
    grafana_url: str = ""
    grafana_token: str = ""
