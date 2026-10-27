"""GitLab proxy: the bare-host upstream and the upstream-URL-on-error diagnostic header."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import scooter_broker_lib.transports.http_proxy as http_proxy_mod
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_gitlab.broker_provider import gitlab
from scooter_broker_lib.transports.http_proxy import HttpProxy


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


def test_gitlab_upstream_is_bare_host(monkeypatch):
    monkeypatch.setenv("GITLAB_TOKEN", "glpat-xxx")
    proxy = next(t for t in gitlab().transports if isinstance(t, HttpProxy))
    assert proxy.upstream == "https://gitlab.com"
    assert not proxy.upstream.endswith("/api/v4")


_REAL_ASYNC_CLIENT = httpx.AsyncClient


@pytest.fixture(autouse=True)
def _restore_async_client():
    """Undo the AsyncClient patch each test does."""
    yield
    http_proxy_mod.httpx.AsyncClient = _REAL_ASYNC_CLIENT  # type: ignore[assignment]


def _app_with_proxy(proxy: HttpProxy, captured: dict) -> FastAPI:
    """Mount just the proxy over a MockTransport that records the outbound URL and returns a chosen status."""
    async def fake_authed() -> Identity:
        return _identity()

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(captured.get("status", 200), json={"ok": True})

    def patched(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        kwargs.pop("timeout", None)
        return _REAL_ASYNC_CLIENT(*args, **kwargs)

    http_proxy_mod.httpx.AsyncClient = patched  # type: ignore[assignment]

    provider = Provider(name="gitlab", credential=None, transports=[proxy], enabled=True)
    app = FastAPI()
    app.include_router(proxy.routes(provider, authed=fake_authed), prefix="/gitlab")
    return app


def test_gitlab_api_path_is_not_double_prefixed():
    captured: dict = {}
    proxy = HttpProxy(upstream="https://gitlab.com")
    app = _app_with_proxy(proxy, captured)
    client = TestClient(app)

    resp = client.get("/gitlab/api/v4/user")
    assert resp.status_code == 200
    assert captured["url"] == "https://gitlab.com/api/v4/user"


def test_failure_surfaces_the_upstream_url_header():
    captured: dict = {"status": 404}
    proxy = HttpProxy(upstream="https://gitlab.com")
    app = _app_with_proxy(proxy, captured)
    client = TestClient(app)

    resp = client.get("/gitlab/api/v4/nope")
    assert resp.status_code == 404
    assert resp.headers.get("x-broker-upstream-url") == "https://gitlab.com/api/v4/nope"


def test_success_does_not_leak_the_upstream_url_header():
    captured: dict = {"status": 200}
    proxy = HttpProxy(upstream="https://gitlab.com")
    app = _app_with_proxy(proxy, captured)
    client = TestClient(app)

    resp = client.get("/gitlab/api/v4/user")
    assert resp.status_code == 200
    assert "x-broker-upstream-url" not in {k.lower() for k in resp.headers}


def test_forge_proxy_intercepts_gitlab_com(monkeypatch):
    from scooter_broker_lib.forge import ALLOW_ALL, find_forge_hosts

    monkeypatch.setenv("GITLAB_TOKEN", "glpat-xxx")
    provider = gitlab()
    forge = find_forge_hosts(provider)
    assert forge is not None
    [host] = forge.hosts
    assert (host.host, host.git, host.api_prefixes) == ("gitlab.com", True, ("/api/",))
    assert forge.git_username == "oauth2"
    assert forge.dialect.api_repo("/api/v4/projects/g%2Fsub%2Fp/merge_requests") == "g/sub/p"
    assert forge.dialect.api_repo("/api/v4/projects/42") == "42"
    assert forge.dialect.is_graphql("/api/graphql")
    assert provider.forge_policy is ALLOW_ALL


def test_gitlab_host_setting(monkeypatch):
    from scooter_broker_lib.forge import find_forge_hosts

    monkeypatch.setenv("GITLAB_TOKEN", "glpat-xxx")
    monkeypatch.setenv("GITLAB_HOST", "gitlab.example.com")
    [host] = find_forge_hosts(gitlab()).hosts
    assert host.host == "gitlab.example.com"
