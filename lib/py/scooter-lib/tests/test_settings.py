"""ScooterBaseSettings, the shared settings base, whose `agent_host_url` default the services override differently."""

from __future__ import annotations

import pytest

from scooter_lib.settings import ScooterBaseSettings


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in ("AGENT_HOST_URL", "AGENT_HOST_TOKEN_PATH", "AGENT_MANAGER_URL"):
        monkeypatch.delenv(var, raising=False)


def test_agent_host_url_defaults_to_empty():
    # A real default would switch broker auto-linking on wherever the var is unset.
    assert ScooterBaseSettings().agent_host_url == ""


def test_token_path_defaults_to_the_projected_sa_token():
    assert ScooterBaseSettings().agent_host_token_path == "/var/run/secrets/agent-host/token"


def test_agent_manager_url_defaults_to_empty():
    assert ScooterBaseSettings().agent_manager_url == ""


@pytest.mark.parametrize(
    "env_var,field,value",
    [
        ("AGENT_HOST_URL", "agent_host_url", "http://agent-host:8080"),
        ("AGENT_HOST_TOKEN_PATH", "agent_host_token_path", "/tmp/tok"),
        ("AGENT_MANAGER_URL", "agent_manager_url", "https://scooter.example.test"),
    ],
)
def test_reads_the_env_var_the_manifests_already_inject(monkeypatch, env_var, field, value):
    monkeypatch.setenv(env_var, value)
    assert getattr(ScooterBaseSettings(), field) == value


def test_env_lookup_is_case_insensitive(monkeypatch):
    monkeypatch.setenv("agent_host_url", "http://lowercase:8080")
    assert ScooterBaseSettings().agent_host_url == "http://lowercase:8080"


def test_a_subclass_may_override_a_default_without_touching_the_base():
    class Sub(ScooterBaseSettings):
        agent_host_url: str = "http://agent-host.agent-sandbox.svc.cluster.local:8080"

    assert Sub().agent_host_url == "http://agent-host.agent-sandbox.svc.cluster.local:8080"
    assert ScooterBaseSettings().agent_host_url == ""


def test_a_subclass_still_reads_the_env_over_its_own_default(monkeypatch):
    class Sub(ScooterBaseSettings):
        agent_host_url: str = "http://default:8080"

    monkeypatch.setenv("AGENT_HOST_URL", "http://from-env:8080")
    assert Sub().agent_host_url == "http://from-env:8080"


def test_two_instances_read_the_same_environment(monkeypatch):
    monkeypatch.setenv("AGENT_HOST_URL", "http://shared:8080")
    assert ScooterBaseSettings().agent_host_url == ScooterBaseSettings().agent_host_url == "http://shared:8080"
