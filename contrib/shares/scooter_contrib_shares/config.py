"""shares settings, owned by this contrib and rendered by its deployment.nix."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class SharesSettings(ScooterBaseSettings):
    # The external origin of a returned share URL; empty returns a relative /s/<uuid>/.
    shares_public_base_url: str = ""
    # The CSP frame-ancestors allowlist for a served share (space-separated origins, or 'self').
    shares_frame_ancestors: str = "'self'"


settings = SharesSettings()
