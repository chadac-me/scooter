"""tokenproxy providers: one per TOKENPROXY_PROVIDERS entry, its intercepted host, and its re-read token."""

from __future__ import annotations

import importlib
import json

import httpx
import pytest

from scooter_broker_lib import registry
from scooter_broker_lib.forge import find_forge_hosts
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Identity

IDENT = Identity(conversation_id="c", namespace="ns", service_account="sa")

PROVIDERS = {
    "billing": {"url": "https://billing.example.com/", "apiPrefixes": ["/v1/"], "credential": {"kind": "bearer"}},
    "metrics": {"url": "https://metrics.example.com", "apiPrefixes": ["/"],
                "credential": {"kind": "header", "headerName": "X-Api-Key"}},
}


@pytest.fixture
def tokens(monkeypatch, tmp_path):
    from broker.config import settings
    import broker.providers.tokenproxy as m

    monkeypatch.setattr(settings, "tokenproxy_providers", json.dumps(PROVIDERS))
    monkeypatch.setattr(settings, "tokenproxy_dir", str(tmp_path))
    importlib.reload(m)
    try:
        yield tmp_path
    finally:
        for name in PROVIDERS:
            registry._REGISTRY.pop(f"tokenproxy:{name}", None)


def build(name: str):
    return registry._REGISTRY[f"tokenproxy:{name}"]()


def test_a_provider_per_entry_named_for_its_contrib(tokens):
    p = build("billing")
    assert p.enabled and p.name == "billing"
    (h,) = find_forge_hosts(p).hosts
    assert (h.host, h.api_prefixes) == ("billing.example.com", ("/v1/",))
    (proxy,) = [t for t in p.transports if isinstance(t, HttpProxy)]
    assert proxy.upstream == "https://billing.example.com"


def test_none_without_config(monkeypatch):
    from broker.config import settings
    import broker.providers.tokenproxy as m

    monkeypatch.setattr(settings, "tokenproxy_providers", "{}")
    importlib.reload(m)
    assert not [k for k in registry._REGISTRY if k.startswith("tokenproxy:")]


async def test_token_is_reread_and_sent_in_the_configured_header(tokens):
    p = build("metrics")
    req = httpx.Request("GET", "https://metrics.example.com/q")
    (await p.credential.get(IDENT)).inject(req)
    assert "x-api-key" not in req.headers

    (tokens / "metrics").mkdir()
    (tokens / "metrics" / "token").write_text("k1\n")
    assert (await p.credential.get(IDENT)).value == "k1"
    (tokens / "metrics" / "token").write_text("k2")
    req = httpx.Request("GET", "https://metrics.example.com/q")
    (await p.credential.get(IDENT)).inject(req)
    assert req.headers["x-api-key"] == "k2" and "authorization" not in req.headers


def test_mounts_under_its_name(tokens):
    from broker.core.app import create_app

    paths = create_app().openapi()["paths"]
    assert any(p.startswith("/billing/") for p in paths), f"mounted: {sorted(paths)}"
