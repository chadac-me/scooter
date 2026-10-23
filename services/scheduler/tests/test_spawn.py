"""Tier 1: spawn_conversation creates a conversation, then prompts the id the server assigned."""

import json

import httpx
import pytest

from scheduler.spawn import spawn, spawn_conversation

SERVER_ID = "11111111-2222-3333-4444-555555555555"


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch):
    from scheduler.config import settings

    monkeypatch.setattr(settings, "spawn_backoff_seconds", 0.0)


class _Agent:
    """A fake agent-host: records both calls and returns a server-assigned id."""

    def __init__(self, create_status=201, prompt_status=200, server_id=SERVER_ID):
        self.create_status = create_status
        self.prompt_status = prompt_status
        self.server_id = server_id
        self.create_body = None
        self.create_headers = None
        self.prompt_body = None
        self.calls: list[str] = []

    async def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append(f"{request.method} {path}")
        if path.endswith("/conversations"):
            self.create_body = json.loads(request.content or b"{}")
            self.create_headers = request.headers
            if self.create_status >= 300:
                return httpx.Response(self.create_status)
            return httpx.Response(self.create_status, json={"id": self.server_id, "status": "pending"})
        # /agui
        self.prompt_body = json.loads(request.content)
        return httpx.Response(self.prompt_status)


async def _spawn(agent: _Agent, **kw):
    transport = httpx.MockTransport(agent.handler)
    async with httpx.AsyncClient(transport=transport) as client:
        return await spawn_conversation(
            kw.pop("prompt", "check the dashboard"),
            title=kw.pop("title", "daily"),
            owner=kw.pop("owner", "alice"),
            client=client,
        )


@pytest.mark.asyncio
async def test_spawn_creates_then_prompts_the_server_assigned_id():
    agent = _Agent()
    conv = await _spawn(agent)

    assert agent.calls == ["POST /conversations", "POST /agui"]
    assert conv == SERVER_ID
    assert agent.prompt_body["threadId"] == SERVER_ID
    assert agent.prompt_body["messages"][0] == {"role": "user", "content": "check the dashboard"}
    assert agent.prompt_body["source"] == "scheduler"


@pytest.mark.asyncio
async def test_spawn_never_invents_its_own_id():
    """The scheduler must not choose the id."""
    agent = _Agent(server_id="server-chosen")
    conv = await _spawn(agent)
    assert conv == "server-chosen"
    assert "threadId" not in agent.create_body
    assert "id" not in agent.create_body


@pytest.mark.asyncio
async def test_title_rides_the_create_call():
    agent = _Agent()
    await _spawn(agent, title="daily digest")
    assert agent.create_body["title"] == "daily digest"


@pytest.mark.asyncio
async def test_owner_is_sent_on_both_calls():
    agent = _Agent()
    await _spawn(agent, owner="alice")
    # The owner rides the body, not an identity header whose name is deployment-configurable.
    assert agent.create_body["owner"] == "alice"
    assert "x-auth-user" not in {k.lower() for k in agent.create_headers}
    assert agent.prompt_body["owner"] == "alice"


@pytest.mark.asyncio
async def test_spawn_returns_none_when_create_fails():
    """A failed create means there is no conversation to prompt."""
    agent = _Agent(create_status=502)
    conv = await _spawn(agent)
    assert conv is None
    assert agent.calls == ["POST /conversations"] * 3  # retried, then given up


@pytest.mark.asyncio
async def test_spawn_returns_none_when_create_returns_no_id():
    agent = _Agent()
    agent.server_id = None
    transport = httpx.MockTransport(agent.handler)
    async with httpx.AsyncClient(transport=transport) as client:
        conv = await spawn_conversation("p", title="t", owner=None, client=client)
    assert conv is None


@pytest.mark.asyncio
async def test_spawn_returns_none_on_prompt_error_status():
    agent = _Agent(prompt_status=502)
    conv = await _spawn(agent)
    assert conv is None


@pytest.mark.asyncio
async def test_spawn_omits_optional_fields_when_absent():
    agent = _Agent()
    transport = httpx.MockTransport(agent.handler)
    async with httpx.AsyncClient(transport=transport) as client:
        conv = await spawn_conversation("p", title=None, owner=None, client=client)
    assert conv == SERVER_ID
    assert "title" not in agent.create_body
    assert "owner" not in agent.create_body
    assert "owner" not in agent.prompt_body


class _Flaky(_Agent):
    """Fails the first `fail` calls to `path` with `exc` (or `status`), then behaves."""

    def __init__(self, path, fail, exc=None, status=None, **kw):
        super().__init__(**kw)
        self.path, self.fail, self.exc, self.status = path, fail, exc, status

    async def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(self.path) and self.fail > 0:
            self.fail -= 1
            self.calls.append(f"{request.method} {request.url.path}")
            if self.exc:
                raise self.exc("boom", request=request)
            return httpx.Response(self.status)
        return await super().handler(request)


@pytest.mark.asyncio
async def test_create_read_timeout_is_retried():
    agent = _Flaky("/conversations", 1, exc=httpx.ReadTimeout)
    assert await _spawn(agent) == SERVER_ID
    assert agent.calls == ["POST /conversations", "POST /conversations", "POST /agui"]


@pytest.mark.asyncio
async def test_prompt_no_pod_ready_503_is_retried():
    agent = _Flaky("/agui", 2, status=503)
    assert await _spawn(agent) == SERVER_ID
    assert agent.calls.count("POST /agui") == 3


@pytest.mark.asyncio
async def test_prompt_read_timeout_is_NOT_retried_since_it_may_have_been_delivered():
    agent = _Flaky("/agui", 1, exc=httpx.ReadTimeout)
    res = await spawn("p", title="t", owner=None, client=httpx.AsyncClient(transport=httpx.MockTransport(agent.handler)))
    assert res.conversation_id is None
    assert res.error and "prompt failed: ReadTimeout" in res.error
    assert agent.calls.count("POST /agui") == 1


@pytest.mark.asyncio
async def test_prompt_connect_error_is_retried():
    agent = _Flaky("/agui", 1, exc=httpx.ConnectError)
    assert await _spawn(agent) == SERVER_ID
    assert agent.calls.count("POST /agui") == 2


def test_default_timeouts_outlast_a_revive():
    from scheduler.config import settings
    from scheduler.spawn import _timeout

    t = _timeout()
    assert t.read == settings.spawn_read_timeout_seconds >= 60
    assert t.connect == settings.spawn_connect_timeout_seconds
