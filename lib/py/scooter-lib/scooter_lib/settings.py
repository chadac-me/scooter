"""The shared settings base, which services subclass and contribs construct directly."""

from __future__ import annotations

from pydantic_settings import BaseSettings


class ScooterBaseSettings(BaseSettings):
    """Config more than one service shares, plus the env-reading convention."""

    # Empty means off to the agent-host clients, so services that need one override the default.
    agent_host_url: str = ""

    agent_host_token_path: str = "/var/run/secrets/agent-host/token"

    # Empty degrades "View conversation" deep-links to the raw id.
    agent_manager_url: str = ""

    # No prefix and case-insensitive, so a field named `datadog_api_key` reads DATADOG_API_KEY.
    model_config = {"env_prefix": "", "case_sensitive": False}
