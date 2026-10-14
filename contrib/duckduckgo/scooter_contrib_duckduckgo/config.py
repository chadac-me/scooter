"""DuckDuckGo settings, owned by this contrib rather than the broker app."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class DuckduckgoSettings(ScooterBaseSettings):
    # A flag rather than a key, since there is no key; default off so no deployment scrapes DDG merely for building this contrib in.
    duckduckgo_enabled: bool = False
