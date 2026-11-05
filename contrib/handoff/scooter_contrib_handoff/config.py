"""handoff settings, owned by this contrib."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class HandoffSettings(ScooterBaseSettings):
    handoff_enabled: bool = False
    handoff_public_base_url: str = ""
    handoff_max_bundle_bytes: int = 1024**3
    handoff_sandbox_quota_bytes: int = 5 * 1024**3
    handoff_bundle_ttl_days: int = 14


settings = HandoffSettings()
