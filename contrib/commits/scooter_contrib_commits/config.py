"""commits settings, owned by this contrib."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class CommitsSettings(ScooterBaseSettings):
    commits_enabled: bool = False
