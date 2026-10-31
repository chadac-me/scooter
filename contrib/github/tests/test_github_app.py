"""The GitHub App credential source over mocked HTTP: the JWT/installation-token flow produces the Credential and caches it."""

from __future__ import annotations

import httpx
import pytest

from scooter_contrib_github.github_app import GitHubAppSource
from scooter_broker_lib.types import Identity


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


def _rsa_key() -> str:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()


@pytest.mark.asyncio
async def test_github_app_source_mints_and_caches(monkeypatch):
    calls = {"n": 0}

    async def fake_post(self, url, **kwargs):  # noqa: ANN001
        calls["n"] += 1
        assert "access_tokens" in url
        assert kwargs["headers"]["Authorization"].startswith("Bearer ")
        return httpx.Response(200, json={"token": "ghs_installation_token"}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    src = GitHubAppSource(app_id="123", private_key=_rsa_key(), installation_id=42)
    cred = await src.get(_identity())
    assert cred.kind == "bearer"
    assert cred.value == "ghs_installation_token"

    await src.get(_identity())
    assert calls["n"] == 1


def test_app_jwt_survives_a_fast_clock(monkeypatch):
    """GitHub rejects an exp over 10 minutes ahead; a 30s-fast host must stay inside it."""
    import time

    import jwt

    real = time.time()
    monkeypatch.setattr(time, "time", lambda: real + 30)
    token = GitHubAppSource(app_id="123", private_key=_rsa_key(), installation_id=42)._generate_jwt()
    claims = jwt.decode(token, options={"verify_signature": False})
    assert claims["exp"] - real <= 10 * 60, "exp lands past GitHub's 10-minute limit"
    assert claims["iat"] <= real, "iat must not be in GitHub's future"


# --- several owners -----------------------------------------------------------

from scooter_broker_lib.forge import ForgeRequest  # noqa: E402

_INSTALLATIONS = [
    {"id": 101, "account": {"login": "chadac"}},
    {"id": 202, "account": {"login": "Chadac-Me"}},
    {"id": 303, "account": {"login": "stranger"}},
]


def _req(repo: str | None = None, variables: dict | None = None) -> ForgeRequest:
    return ForgeRequest(
        identity=_identity(), provider="github", via="forge-proxy", method="POST",
        host="api.github.com", path="/graphql", kind="api", repo=repo,
        graphql_variables=(variables,) if variables is not None else None,
    )


@pytest.fixture
def github(monkeypatch):
    """Fake GitHub: lists _INSTALLATIONS and mints `tok-<installation>`."""
    calls = {"list": 0, "mint": []}

    async def fake_get(self, url, **kwargs):  # noqa: ANN001
        assert "/app/installations" in url
        calls["list"] += 1
        return httpx.Response(200, json=_INSTALLATIONS, request=httpx.Request("GET", url))

    async def fake_post(self, url, **kwargs):  # noqa: ANN001
        inst = int(url.split("/app/installations/")[1].split("/")[0])
        calls["mint"].append(inst)
        return httpx.Response(200, json={"token": f"tok-{inst}"}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    return calls


def _source(**kw) -> GitHubAppSource:
    return GitHubAppSource(app_id="123", private_key=_rsa_key(), **{"owners": ("chadac", "chadac-me"), **kw})


@pytest.mark.asyncio
async def test_each_owner_gets_its_own_installation(github):
    src = _source()
    assert (await src.get(_identity(), _req("chadac/server-config"))).value == "tok-101"
    assert (await src.get(_identity(), _req("chadac-me/scooter"))).value == "tok-202"
    assert (await src.get(_identity(), _req("CHADAC-ME/scooter"))).value == "tok-202"
    assert github["list"] == 1, "the installation list is cached"
    assert github["mint"] == [101, 202], "tokens are cached per installation"


@pytest.mark.asyncio
async def test_unlisted_owner_never_gets_its_installation(github):
    """A stranger's installation of a public App is never used."""
    src = _source(installation_id=101)
    cred = await src.get(_identity(), _req("stranger/exfil"))
    assert cred.value == "tok-101"
    assert 303 not in github["mint"]


@pytest.mark.asyncio
async def test_graphql_owner_variable_picks_the_installation(github):
    src = _source(installation_id=101)
    cred = await src.get(_identity(), _req(variables={"owner": "chadac-me", "name": "scooter"}))
    assert cred.value == "tok-202"


@pytest.mark.asyncio
async def test_ownerless_call_follows_the_conversation(github):
    """gh's createPullRequest names the repo by node id only."""
    src = _source(installation_id=101)
    await src.get(_identity(), _req("chadac-me/scooter"))
    cred = await src.get(_identity(), _req(variables={"input": {"repositoryId": "R_x"}}))
    assert cred.value == "tok-202"
    other = Identity("conv2", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv2")
    assert (await src.get(other, None)).value == "tok-101", "another conversation keeps the default"


@pytest.mark.asyncio
async def test_default_is_the_first_installed_owner(github):
    src = _source(owners=("not-installed", "chadac-me"))
    assert (await src.get(_identity(), None)).value == "tok-202"


@pytest.mark.asyncio
async def test_a_miss_relists_at_most_once_a_minute(github, monkeypatch):
    src = _source(owners=("chadac", "chadac-me", "later"), installation_id=101)
    await src.get(_identity(), _req("later/repo"))
    await src.get(_identity(), _req("later/repo"))
    assert github["list"] == 1
    _INSTALLATIONS.append({"id": 404, "account": {"login": "later"}})
    try:
        import scooter_contrib_github.github_app as ga
        monkeypatch.setattr(ga.time, "time", lambda real=ga.time.time(): real + 61)
        assert (await src.get(_identity(), _req("later/repo"))).value == "tok-404"
        assert github["list"] == 2
    finally:
        _INSTALLATIONS.pop()


@pytest.mark.asyncio
async def test_no_owners_keeps_the_single_installation(github):
    src = GitHubAppSource(app_id="123", private_key=_rsa_key(), installation_id=42)
    assert (await src.get(_identity(), _req("chadac-me/scooter"))).value == "tok-42"
    assert github["list"] == 0


@pytest.mark.asyncio
async def test_a_reinstall_is_picked_up(github, monkeypatch):
    """A 404 on mint drops the stale id, so the next call re-lists."""
    src = _source(installation_id=101)
    assert (await src.get(_identity(), _req("chadac-me/scooter"))).value == "tok-202"
    src._tokens.clear()

    async def gone(self, url, **kwargs):  # noqa: ANN001
        return httpx.Response(404, json={}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", gone)
    with pytest.raises(httpx.HTTPStatusError):
        await src.get(_identity(), _req("chadac-me/scooter"))
    _INSTALLATIONS[1] = {"id": 505, "account": {"login": "chadac-me"}}
    try:
        async def mint(self, url, **kwargs):  # noqa: ANN001
            inst = int(url.split("/app/installations/")[1].split("/")[0])
            return httpx.Response(200, json={"token": f"tok-{inst}"}, request=httpx.Request("POST", url))

        monkeypatch.setattr(httpx.AsyncClient, "post", mint)
        assert (await src.get(_identity(), _req("chadac-me/scooter"))).value == "tok-505"
    finally:
        _INSTALLATIONS[1] = {"id": 202, "account": {"login": "Chadac-Me"}}
