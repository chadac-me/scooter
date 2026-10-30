"""Wire the lib modules the way `webhooks.app` does, since a test that imports a handler module directly would otherwise hit the "init() was never called" guard."""

from __future__ import annotations

import pytest

from scooter_webhooks_lib import agent_host_client, policy

from webhooks.config import settings


@pytest.fixture(autouse=True)
def _bind_agent_host_config():
    agent_host_client.init(settings)
    policy.init(settings)
    yield
