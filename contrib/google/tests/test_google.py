"""Google provider: the service-account assertion, token caching, owner impersonation, the host allowlist and enable gating."""

from __future__ import annotations

import json
import time

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Identity
from scooter_contrib_google import service_account as sa_mod
from scooter_contrib_google.broker_provider import ALLOWED_HOSTS, GoogleApiProxy, google
from scooter_contrib_google.config import DEFAULT_SCOPES
from scooter_contrib_google.service_account import GoogleServiceAccountSource, SubjectNotAllowed

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PEM = _KEY.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
).decode()
_PUB = _KEY.public_key()

INFO = {
    "type": "service_account",
    "client_email": "scooter@proj.iam.gserviceaccount.com",
    "private_key": _PEM,
    "private_key_id": "kid123",
    "token_uri": "https://oauth2.googleapis.com/token",
}


def _identity(owner: str | None = None) -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1", owner=owner)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in ("GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_SUBJECT", "GOOGLE_SCOPES",
              "GOOGLE_IMPERSONATE_OWNER", "GOOGLE_OWNER_DOMAINS"):
        monkeypatch.delenv(k, raising=False)


class _FakeTokenEndpoint:
    """Stands in for httpx.AsyncClient, recording the assertions posted to the token URI."""

    calls: list[dict] = []

    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, data):
        _FakeTokenEndpoint.calls.append({"url": url, **data})
        req = httpx.Request("POST", url)
        n = len(_FakeTokenEndpoint.calls)
        return httpx.Response(200, json={"access_token": f"ya29.tok{n}", "expires_in": 3599}, request=req)


@pytest.fixture
def token_endpoint(monkeypatch):
    _FakeTokenEndpoint.calls = []
    monkeypatch.setattr(sa_mod.httpx, "AsyncClient", _FakeTokenEndpoint)
    return _FakeTokenEndpoint


def _claims(assertion: str) -> dict:
    return jwt.decode(assertion, _PUB, algorithms=["RS256"], audience=INFO["token_uri"])


def test_assertion_is_signed_with_the_key_and_carries_scopes_and_subject():
    src = GoogleServiceAccountSource(info=INFO, scopes=["s1", "s2"], subject="me@example.com")
    now = int(time.time())
    a = src.assertion("me@example.com", now)
    claims = _claims(a)
    assert claims["iss"] == INFO["client_email"]
    assert claims["scope"] == "s1 s2"
    assert claims["sub"] == "me@example.com"
    assert claims["exp"] - claims["iat"] == 3600
    assert jwt.get_unverified_header(a)["kid"] == "kid123"


def test_no_subject_means_no_sub_claim():
    src = GoogleServiceAccountSource(info=INFO, scopes=["s"])
    assert "sub" not in _claims(src.assertion("", int(time.time())))


async def test_exchanges_the_assertion_and_caches_the_token(token_endpoint):
    src = GoogleServiceAccountSource(info=INFO, scopes=["s"], subject="me@example.com")
    c1 = await src.get(_identity())
    c2 = await src.get(_identity())
    assert c1.kind == "bearer" and c1.value == "ya29.tok1"
    assert c2.value == "ya29.tok1"
    assert len(token_endpoint.calls) == 1
    call = token_endpoint.calls[0]
    assert call["url"] == INFO["token_uri"]
    assert call["grant_type"] == "urn:ietf:params:oauth:grant-type:jwt-bearer"
    req = httpx.Request("GET", "https://www.googleapis.com/drive/v3/files")
    c1.inject(req)
    assert req.headers["Authorization"] == "Bearer ya29.tok1"


async def test_owner_impersonation_caches_per_owner(token_endpoint):
    src = GoogleServiceAccountSource(
        info=INFO, scopes=["s"], impersonate_owner=True, owner_domains={"example.com"}
    )
    a = await src.get(_identity("Alice@Example.com"))
    b = await src.get(_identity("bob@example.com"))
    assert a.value != b.value
    subs = [_claims(c["assertion"])["sub"] for c in token_endpoint.calls]
    assert subs == ["alice@example.com", "bob@example.com"]


@pytest.mark.parametrize("owner", [None, "", "mallory@evil.com", "not-an-email", "x@example.com.evil.com"])
async def test_owner_outside_the_domains_is_refused_without_fallback(token_endpoint, owner):
    src = GoogleServiceAccountSource(
        info=INFO, scopes=["s"], subject="fallback@example.com",
        impersonate_owner=True, owner_domains={"example.com"},
    )
    with pytest.raises(SubjectNotAllowed):
        await src.get(_identity(owner))
    assert token_endpoint.calls == []


def test_provider_is_enabled_by_a_valid_key(monkeypatch):
    monkeypatch.setenv("GOOGLE_SERVICE_ACCOUNT_JSON", json.dumps(INFO))
    monkeypatch.setenv("GOOGLE_SUBJECT", "me@example.com")
    p = google()
    assert p.name == "google" and p.enabled is True
    assert p.credential.inner.subject == "me@example.com"
    assert p.credential.inner.scopes == list(DEFAULT_SCOPES)


def test_default_scopes_are_read_only():
    assert all(s.endswith(".readonly") for s in DEFAULT_SCOPES)


def test_scopes_are_configurable(monkeypatch):
    monkeypatch.setenv("GOOGLE_SERVICE_ACCOUNT_JSON", json.dumps(INFO))
    monkeypatch.setenv("GOOGLE_SCOPES", "a, b c")
    assert google().credential.inner.scopes == ["a", "b", "c"]


@pytest.mark.parametrize("raw", ["", "  ", "{not json", json.dumps({"client_email": "x"}), "[]"])
def test_requires_a_valid_key(monkeypatch, raw):
    monkeypatch.setenv("GOOGLE_SERVICE_ACCOUNT_JSON", raw)
    assert google().enabled is False


def test_impersonate_owner_without_domains_disables(monkeypatch):
    monkeypatch.setenv("GOOGLE_SERVICE_ACCOUNT_JSON", json.dumps(INFO))
    monkeypatch.setenv("GOOGLE_IMPERSONATE_OWNER", "true")
    assert google().enabled is False


def test_each_allowed_host_gets_its_own_upstream():
    t = GoogleApiProxy()
    assert set(t.proxies) == set(ALLOWED_HOSTS)
    for host, proxy in t.proxies.items():
        assert isinstance(proxy, HttpProxy)
        assert proxy.upstream == f"https://{host}.googleapis.com"


def _app(monkeypatch, owner=None):
    monkeypatch.setenv("GOOGLE_SERVICE_ACCOUNT_JSON", json.dumps(INFO))
    monkeypatch.setenv("GOOGLE_IMPERSONATE_OWNER", "true")
    monkeypatch.setenv("GOOGLE_OWNER_DOMAINS", "example.com")
    p = google()

    async def authed() -> Identity:
        return _identity(owner)

    app = FastAPI()
    for t in p.transports:
        app.include_router(t.routes(p, authed), prefix="/google")
    return TestClient(app)


def test_hosts_outside_the_allowlist_are_not_routed(monkeypatch):
    client = _app(monkeypatch, owner="a@example.com")
    for path in ("/google/evil.com/x", "/google/storage/v1/b", "/google/oauth2/token"):
        assert client.get(path).status_code == 404


def test_disallowed_owner_is_a_403_not_a_500(monkeypatch):
    client = _app(monkeypatch, owner="mallory@evil.com")
    r = client.get("/google/www/drive/v3/files")
    assert r.status_code == 403
