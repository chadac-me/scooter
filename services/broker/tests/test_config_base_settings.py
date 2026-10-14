"""Inheriting from scooter_lib must not change broker behaviour, and in particular `agent_host_url` must stay empty by default since that is the auto-linking off switch."""

from __future__ import annotations

import pytest

from broker.config import BrokerSettings
from scooter_lib.settings import ScooterBaseSettings


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("AGENT_HOST_URL", raising=False)


def test_broker_settings_carries_the_shared_agent_host_fields():
    assert issubclass(BrokerSettings, ScooterBaseSettings)


def test_agent_host_url_is_still_empty_by_default():
    assert BrokerSettings().agent_host_url == ""


def test_agent_host_url_still_reads_its_env_var(monkeypatch):
    monkeypatch.setenv("AGENT_HOST_URL", "http://agent-host:8080")
    assert BrokerSettings().agent_host_url == "http://agent-host:8080"


def test_the_brokers_own_settings_are_untouched():
    s = BrokerSettings()
    assert s.token_audience == "agent-broker"
    assert s.sandbox_namespace == "agent-sandbox"
