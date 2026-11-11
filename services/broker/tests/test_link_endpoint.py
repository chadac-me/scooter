"""The broker's explicit /link endpoints, where the conversation is always taken from the caller's SA token."""

from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

import broker.core.app as app_mod
from broker.core.app import create_app
from broker.core.auth import authenticate
from scooter_broker_lib.types import Identity


def _fake_identity() -> Identity:
    return Identity(
        conversation_id="conv-link1",
        namespace="agent-sandbox",
        service_account="system:serviceaccount:agent-sandbox:sandbox-conv-link1",
    )


def _client() -> TestClient:
    app = create_app()
    app.dependency_overrides[authenticate] = _fake_identity
    return TestClient(app)


def test_post_link_forwards_to_agent_host(monkeypatch):
    captured: dict = {}

    async def fake_create_link(agent_host_url, conversation_id, link):
        captured.update(url=agent_host_url, conv=conversation_id, link=link)

    monkeypatch.setattr(app_mod, "create_link", fake_create_link)
    monkeypatch.setattr(app_mod.settings, "agent_host_url", "http://agent-host:8080")

    resp = _client().post(
        "/link",
        json={"source": "github", "resourceType": "pr", "url": "https://x/pull/1", "title": "T"},
    )

    assert resp.status_code == 201
    assert resp.json() == {"status": "linked"}
    # The conversation comes from the token, not the body.
    assert captured["conv"] == "conv-link1"
    assert captured["link"].url == "https://x/pull/1"
    assert captured["link"].resource_type == "pr"


def test_patch_link_records_state_for_the_token_s_conversation(monkeypatch):
    captured: dict = {}

    async def fake_set_link_state(agent_host_url, conversation_id, url, state):
        captured.update(conv=conversation_id, link=url, state=state)

    monkeypatch.setattr(app_mod, "set_link_state", fake_set_link_state)

    resp = _client().patch("/link", json={"url": "https://x/pull/1", "state": "merged"})

    assert resp.status_code == 200
    assert resp.json() == {"status": "updated"}
    # The conversation comes from the token, not the body.
    assert captured == {"conv": "conv-link1", "link": "https://x/pull/1", "state": "merged"}


def test_patch_link_rejects_missing_fields_and_maps_an_unknown_link_to_404(monkeypatch):
    assert _client().patch("/link", json={"url": "https://x/pull/1"}).status_code == 400

    async def no_such_link(agent_host_url, conversation_id, url, state):
        raise LookupError(f"no link for {url} on this conversation")

    monkeypatch.setattr(app_mod, "set_link_state", no_such_link)
    resp = _client().patch("/link", json={"url": "https://x/pull/9", "state": "merged"})
    assert resp.status_code == 404
    assert "no link for https://x/pull/9" in resp.json()["detail"]


def test_post_link_accepts_type_alias(monkeypatch):
    captured: dict = {}

    async def fake_create_link(agent_host_url, conversation_id, link):
        captured["link"] = link

    monkeypatch.setattr(app_mod, "create_link", fake_create_link)
    resp = _client().post("/link", json={"source": "jira", "type": "issue", "url": "https://x/PROJ-1"})
    assert resp.status_code == 201
    assert captured["link"].resource_type == "issue"


def test_post_link_rejects_missing_fields():
    resp = _client().post("/link", json={"source": "github", "url": ""})
    assert resp.status_code == 400


def test_post_link_maps_agent_host_error_to_502(monkeypatch):
    async def boom(*a, **k):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(app_mod, "create_link", boom)
    resp = _client().post("/link", json={"source": "github", "resourceType": "pr", "url": "https://x/1"})
    assert resp.status_code == 502


def test_post_link_maps_no_conversation_to_409(monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("no conversation for this identity — cannot attach a link")

    monkeypatch.setattr(app_mod, "create_link", boom)
    resp = _client().post("/link", json={"source": "github", "resourceType": "pr", "url": "https://x/1"})
    assert resp.status_code == 409


def test_get_link_lists_current_links(monkeypatch):
    async def fake_list_links(agent_host_url, conversation_id):
        assert conversation_id == "conv-link1"
        return [{"source": "github", "resourceType": "pr", "url": "https://x/pull/1"}]

    monkeypatch.setattr(app_mod, "list_links", fake_list_links)
    resp = _client().get("/link")
    assert resp.status_code == 200
    assert resp.json() == {"links": [{"source": "github", "resourceType": "pr", "url": "https://x/pull/1"}]}


def test_get_link_maps_agent_host_error_to_502(monkeypatch):
    async def boom(*a, **k):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(app_mod, "list_links", boom)
    resp = _client().get("/link")
    assert resp.status_code == 502


def test_link_endpoints_require_auth():
    # Without the dependency override the real authenticate runs.
    app = create_app()
    client = TestClient(app)
    assert client.get("/link").status_code in (401, 403)
    assert client.post("/link", json={}).status_code in (401, 403)
