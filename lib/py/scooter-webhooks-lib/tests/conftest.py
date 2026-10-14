"""Bind the agent-host client with a stub config the way a service does at startup."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from scooter_webhooks_lib import agent_host_client


@dataclass
class StubConfig:
    agent_host_url: str = "http://agent-host:8080"
    agent_host_token_path: str = ""
    agent_manager_url: str = "http://scooter.test"


@pytest.fixture(autouse=True)
def agent_host_config():
    cfg = StubConfig()
    agent_host_client.init(cfg)
    return cfg
