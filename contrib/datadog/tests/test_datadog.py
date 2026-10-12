"""Datadog provider: two-key header auth, the http-proxy target and enable gating, driven through the environment."""

from __future__ import annotations

import httpx
import pytest

from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Identity
from scooter_contrib_datadog.broker_provider import datadog
from scooter_contrib_datadog.datadog_keys import DatadogKeysSource


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in ("DATADOG_API_KEY", "DATADOG_APP_KEY", "DATADOG_SITE"):
        monkeypatch.delenv(var, raising=False)


@pytest.mark.asyncio
async def test_datadog_source_injects_both_keys():
    src = DatadogKeysSource(api_key="dd-api", app_key="dd-app")
    cred = await src.get(_identity())
    req = httpx.Request("GET", "https://api.datadoghq.com/api/v1/validate")
    cred.inject(req)
    assert req.headers["DD-API-KEY"] == "dd-api"
    assert req.headers["DD-APPLICATION-KEY"] == "dd-app"


def test_provider_proxies_to_configured_site(monkeypatch):
    monkeypatch.setenv("DATADOG_API_KEY", "k")
    monkeypatch.setenv("DATADOG_APP_KEY", "a")
    monkeypatch.setenv("DATADOG_SITE", "datadoghq.eu")

    provider = datadog()
    assert provider.name == "datadog"
    proxy = next(t for t in provider.transports if isinstance(t, HttpProxy))
    assert proxy.upstream == "https://api.datadoghq.eu"


def test_site_defaults_to_us(monkeypatch):
    monkeypatch.setenv("DATADOG_API_KEY", "k")
    monkeypatch.setenv("DATADOG_APP_KEY", "a")

    proxy = next(t for t in datadog().transports if isinstance(t, HttpProxy))
    assert proxy.upstream == "https://api.datadoghq.com"


@pytest.mark.parametrize("site", [" datadoghq.eu ", ".datadoghq.eu"])
def test_site_is_normalised(monkeypatch, site):
    # A stray leading dot or whitespace must not produce https://api..datadoghq.eu.
    monkeypatch.setenv("DATADOG_API_KEY", "k")
    monkeypatch.setenv("DATADOG_APP_KEY", "a")
    monkeypatch.setenv("DATADOG_SITE", site)

    proxy = next(t for t in datadog().transports if isinstance(t, HttpProxy))
    assert proxy.upstream == "https://api.datadoghq.eu"


def test_provider_disabled_without_both_keys(monkeypatch):
    monkeypatch.setenv("DATADOG_API_KEY", "k")
    assert datadog().enabled is False

    monkeypatch.delenv("DATADOG_API_KEY")
    assert datadog().enabled is False

    monkeypatch.setenv("DATADOG_API_KEY", "k")
    monkeypatch.setenv("DATADOG_APP_KEY", "a")
    assert datadog().enabled is True


def test_reads_the_env_vars_the_manifests_already_inject(monkeypatch):
    # modules/broker.nix injects DATADOG_API_KEY / DATADOG_APP_KEY from secrets.
    monkeypatch.setenv("DATADOG_API_KEY", "from-secret")
    monkeypatch.setenv("DATADOG_APP_KEY", "also-from-secret")

    provider = datadog()
    assert provider.enabled is True
    assert provider.credential.api_key == "from-secret"
    assert provider.credential.app_key == "also-from-secret"
