"""Datadog credential source: a "multi-header" Credential carrying the DD-API-KEY and DD-APPLICATION-KEY headers Datadog requires on every request."""

from __future__ import annotations

import json
from dataclasses import dataclass

from scooter_broker_lib.types import Credential, CredentialSource, Identity


@dataclass
class DatadogKeysSource(CredentialSource):
    api_key: str
    app_key: str

    async def get(self, identity: Identity) -> Credential:
        return Credential(
            kind="multi-header",
            value=json.dumps({
                "DD-API-KEY": self.api_key,
                "DD-APPLICATION-KEY": self.app_key,
            }),
        )
