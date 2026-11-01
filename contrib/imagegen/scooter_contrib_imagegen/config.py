"""imagegen settings: the per-user cap, the selector name, and every backend's own
config in one JSON blob (IMAGEGEN_BACKENDS_JSON, from contribs.imagegen.backends) —
one env var rather than one field per backend, so the Nix side can configure an
open-ended, pluggable set of backends with no matching field here per backend.
"""

from __future__ import annotations

import json
import logging

from scooter_lib.settings import ScooterBaseSettings

logger = logging.getLogger(__name__)


class ImagegenSettings(ScooterBaseSettings):
    imagegen_daily_limit: int = 50
    imagegen_selector: str = "priority"
    imagegen_backends_json: str = "{}"

    def backends_config(self) -> dict[str, dict]:
        """name -> {enable, priority, dailyLimit, ...}, as contribs.imagegen.backends rendered it."""
        try:
            data = json.loads(self.imagegen_backends_json)
        except (TypeError, ValueError):
            logger.warning("IMAGEGEN_BACKENDS_JSON is not valid JSON; treating as no backends configured")
            return {}
        if not isinstance(data, dict):
            return {}
        return data

    def enabled_backends(self) -> dict[str, dict]:
        """The subset of `backends_config()` actually turned on."""
        return {name: cfg for name, cfg in self.backends_config().items() if isinstance(cfg, dict) and cfg.get("enable")}
