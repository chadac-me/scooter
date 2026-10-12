"""Bind the lib surfaces (`policy` and `agent_host_client`) the webhooks service binds at startup."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from scooter_contrib_slack.config import settings as slack_settings
from scooter_webhooks_lib import agent_host_client, policy


@dataclass
class TriggerPolicy:
    """The deployment policy a test drives the handler with."""

    mention_pattern: str = "@scooter"
    label_trigger: str = "scooter"
    ignore_usernames: str = ""
    ignore_bot_authors: bool = True

    def get_repo_descriptions(self) -> dict[str, str]:
        return {}


@pytest.fixture(autouse=True)
def _bind_lib_config():
    policy.init(TriggerPolicy())
    agent_host_client.init(slack_settings)
    yield
