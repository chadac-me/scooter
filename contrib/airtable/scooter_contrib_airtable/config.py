"""Airtable settings, owned by this contrib."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class AirtableSettings(ScooterBaseSettings):
    airtable_token: str = ""
