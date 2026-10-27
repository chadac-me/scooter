"""personalization settings, owned by this contrib."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class PersonalizationSettings(ScooterBaseSettings):
    personalization_enabled: bool = False


settings = PersonalizationSettings()
