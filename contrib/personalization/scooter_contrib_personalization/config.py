"""personalization settings, owned by this contrib."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class PersonalizationSettings(ScooterBaseSettings):
    personalization_enabled: bool = False
    # Where personalization_history reads a user's conversations from.
    personalization_agent_host_url: str = ""


settings = PersonalizationSettings()
