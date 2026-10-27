"""ScooterClient.prompt_conversation: queue a prompt on an existing conversation."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from scooter_lib.client import ConversationGone, ScooterClient, SpawnError


def _sse(*events: dict) -> bytes:
    return b"".join(f"data: {json.dumps(e)}\n\n".encode() for e in events)


def _prompt(tmp_path, handler, **kw):
    (tmp_path / "token").write_text("tok-1\n")

    async def go():
        async with ScooterClient(
            agent_host_url="http://agent-host:8080",
            token_path=str(tmp_path / "token"),
            transport=httpx.MockTransport(handler),
            backoff_seconds=0.0,
        ) as c:
            await c.prompt_conversation("conv-1", "hello", owner="alice", **kw)

    asyncio.run(go())


def test_it_posts_the_prompt_to_the_thread_with_owner_and_source(tmp_path):
    seen = []

    def handler(request):
        seen.append((str(request.url), json.loads(request.content), request.headers.get("authorization")))
        return httpx.Response(200, content=_sse({"type": "RUN_STARTED"}, {"type": "TEXT_MESSAGE_CONTENT", "delta": "hi"}))

    _prompt(tmp_path, handler)
    (url, body, auth), = seen
    assert url == "http://agent-host:8080/agui" and auth == "Bearer tok-1"
    assert body == {
        "threadId": "conv-1",
        "messages": [{"role": "user", "content": "hello"}],
        "source": "scheduler",
        "owner": "alice",
    }


def test_an_unknown_conversation_raises_conversation_gone(tmp_path):
    def handler(request):
        return httpx.Response(200, content=_sse({"type": "RUN_ERROR", "message": "No such conversation", "code": "UNKNOWN_CONVERSATION"}))

    with pytest.raises(ConversationGone):
        _prompt(tmp_path, handler)


def test_another_run_error_is_a_plain_spawn_error(tmp_path):
    def handler(request):
        return httpx.Response(200, content=_sse({"type": "RUN_ERROR", "message": "agent crashed"}))

    with pytest.raises(SpawnError, match="agent crashed") as e:
        _prompt(tmp_path, handler)
    assert not isinstance(e.value, ConversationGone)


def test_a_refused_request_is_an_error(tmp_path):
    with pytest.raises(SpawnError, match="HTTP 403"):
        _prompt(tmp_path, lambda request: httpx.Response(403))


def test_a_busy_conversation_that_streams_nothing_counts_as_queued(tmp_path):
    class _Silent(httpx.AsyncByteStream):
        async def __aiter__(self):
            await asyncio.sleep(10)
            yield b""

    _prompt(tmp_path, lambda request: httpx.Response(200, stream=_Silent()), accept_wait_seconds=0.05)


def test_a_503_is_retried_then_delivered(tmp_path):
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(503) if len(calls) == 1 else httpx.Response(200, content=_sse({"type": "RUN_STARTED"}))

    _prompt(tmp_path, handler)
    assert len(calls) == 2
