"""Unit tests for the agent-host client against a mocked AG-UI SSE stream."""

from __future__ import annotations

import httpx
import pytest

from scooter_webhooks_lib import agent_host_client as ahc


def _sse(*events: str) -> bytes:
    return "".join(f"data: {e}\n\n" for e in events).encode()


class _FakeStream:
    def __init__(self, body: bytes):
        self._body = body
        self.status_code = 200

    def raise_for_status(self):
        pass

    async def aiter_lines(self):
        for line in self._body.decode().splitlines():
            yield line

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


# The id the fake server assigns.
SERVER_CONV_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def _patch_create(monkeypatch, captured: dict | None = None, status: int = 201, conv_id=SERVER_CONV_ID):
    """Stub POST /conversations with a server-assigned id."""

    async def fake_post(self, url, **kwargs):  # noqa: ANN001
        if captured is not None:
            captured["create_url"] = url
            captured["create_json"] = kwargs.get("json")
            captured["create_headers"] = kwargs.get("headers")
        payload = {"id": conv_id, "status": "pending"} if conv_id else {"status": "pending"}
        return httpx.Response(status, json=payload, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)


def _patch_stream(monkeypatch, body: bytes, captured: dict | None = None):
    def fake_stream(self, method, url, **kwargs):  # noqa: ANN001
        if captured is not None:
            captured["url"] = url
            captured["json"] = kwargs.get("json")
        return _FakeStream(body)

    monkeypatch.setattr(httpx.AsyncClient, "stream", fake_stream)
    _patch_create(monkeypatch, captured)


async def test_create_conversation_collects_final_message(monkeypatch):
    captured: dict = {}
    body = _sse(
        '{"type":"RUN_STARTED","threadId":"t","runId":"r"}',
        '{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"Done: "}',
        '{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"fixed it."}',
        '{"type":"RUN_FINISHED","threadId":"t","runId":"r"}',
    )
    _patch_stream(monkeypatch, body, captured)

    result = await ahc.create_conversation("fix the bug", repository="o/r")

    assert result is not None
    assert result["result"] == "Done: fixed it."
    assert result["conversation_id"]
    assert captured["json"]["messages"][0]["content"].startswith("Repository: o/r")
    assert captured["json"]["threadId"] == result["conversation_id"]


async def test_on_created_fires_with_conv_id_BEFORE_the_run(monkeypatch):
    # The agent may call a response tool on its first turn, so the target link must be registered before the /agui stream opens.
    order: list[str] = []

    def fake_stream(self, method, url, **kwargs):  # noqa: ANN001
        order.append("run")
        return _FakeStream(_sse('{"type":"RUN_FINISHED","threadId":"t","runId":"r"}'))

    monkeypatch.setattr(httpx.AsyncClient, "stream", fake_stream)
    _patch_create(monkeypatch)

    seen: dict = {}

    async def on_created(conv_id: str) -> None:
        order.append("on_created")
        seen["conv_id"] = conv_id

    result = await ahc.create_conversation("do a thing", on_created=on_created)
    assert result is not None
    assert seen["conv_id"] == result["conversation_id"]
    assert order == ["on_created", "run"]


async def test_on_created_failure_is_non_fatal(monkeypatch):
    _patch_stream(monkeypatch, _sse('{"type":"RUN_FINISHED","threadId":"t","runId":"r"}'))

    async def boom(_conv_id: str) -> None:
        raise RuntimeError("registration failed")

    result = await ahc.create_conversation("do a thing", on_created=boom)
    assert result is not None


async def test_run_error_is_ERRORED_not_none(monkeypatch):
    # The conversation already exists and did work, so a crash mid-run is `errored`, not None.
    body = _sse(
        '{"type":"RUN_STARTED","threadId":"t","runId":"r"}',
        '{"type":"RUN_ERROR","message":"agent blew up"}',
    )
    _patch_stream(monkeypatch, body)

    result = await ahc.create_conversation("do a thing")
    assert result is not None
    assert result.get("errored") is True
    assert result.get("error") == "agent blew up"
    assert "conversation_id" in result


async def test_connection_drop_mid_run_is_INTERRUPTED_not_failed(monkeypatch):
    # A transport error mid-run is transient (the agent-host resumes on boot), so it is `interrupted`, not None.
    class _DroppingStream(_FakeStream):
        async def aiter_lines(self):
            yield 'data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}'
            raise httpx.ReadError("connection reset")

    monkeypatch.setattr(httpx.AsyncClient, "stream", lambda *a, **k: _DroppingStream(b""))
    _patch_create(monkeypatch)
    result = await ahc.create_conversation("do a thing")
    assert result is not None
    assert result.get("interrupted") is True
    assert result["conversation_id"]


async def test_stream_ending_before_RUN_FINISHED_is_INTERRUPTED(monkeypatch):
    # A graceful close without RUN_FINISHED is also interrupted.
    _patch_stream(monkeypatch, _sse('{"type":"RUN_STARTED","threadId":"t","runId":"r"}'))
    result = await ahc.create_conversation("do a thing")
    assert result is not None
    assert result.get("interrupted") is True


async def test_send_message_posts_to_same_thread(monkeypatch):
    captured: dict = {}
    _patch_stream(monkeypatch, _sse('{"type":"RUN_FINISHED","threadId":"c1","runId":"r"}'), captured)

    ok = await ahc.send_message("c1", "a follow-up")
    assert ok is True
    assert captured["json"]["threadId"] == "c1"
    assert captured["json"]["messages"][0]["content"] == "a follow-up"


def test_resolve_sandbox_is_identity():
    import asyncio

    assert asyncio.run(ahc.resolve_sandbox_to_conversation("conv-x")) == "conv-x"


# --- status fetch distinguishes a 404 from a transient failure -------
# Both return None, but a transient failure logs at WARNING and a 404 at debug.

def _patch_get(monkeypatch, handler):
    """Route the module's httpx.AsyncClient through a MockTransport handler."""
    real_client = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.pop("transport", None)
        return real_client(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(ahc.httpx, "AsyncClient", factory)


async def test_status_404_returns_none(monkeypatch):
    _patch_get(monkeypatch, lambda req: httpx.Response(404))
    assert await ahc.get_conversation_status("c1") is None


async def test_status_ok_returns_status(monkeypatch):
    _patch_get(monkeypatch, lambda req: httpx.Response(200, json={"status": "running"}))
    assert await ahc.get_conversation_status("c1") == "running"


async def test_status_5xx_returns_none_and_warns(monkeypatch, caplog):
    import logging

    _patch_get(monkeypatch, lambda req: httpx.Response(503))
    with caplog.at_level(logging.WARNING, logger="webhooks.agent_host_client"):
        assert await ahc.get_conversation_status("c1") is None
    # msg is a constant; the varying detail rides as structured fields.
    warned = [r for r in caplog.records if r.message == "status fetch failed, transient, will retry"]
    assert warned
    assert warned[0].conversation_id == "c1"
    assert warned[0].error["status"] == 503


# --- multimodal content: images -> text+image parts array -----------


async def test_create_conversation_with_images_sends_content_parts(monkeypatch):
    captured: dict = {}
    body = _sse(
        '{"type":"RUN_STARTED","threadId":"t","runId":"r"}',
        '{"type":"RUN_FINISHED","threadId":"t","runId":"r"}',
    )
    _patch_stream(monkeypatch, body, captured)

    await ahc.create_conversation(
        "what is this?",
        images=[{"data": "QUJD", "mimeType": "image/png"}],
    )

    content = captured["json"]["messages"][0]["content"]
    assert isinstance(content, list)
    assert {"type": "text", "text": "what is this?"} in content
    assert {"type": "image", "data": "QUJD", "mimeType": "image/png"} in content


async def test_create_conversation_without_images_sends_a_plain_string(monkeypatch):
    captured: dict = {}
    body = _sse(
        '{"type":"RUN_STARTED","threadId":"t","runId":"r"}',
        '{"type":"RUN_FINISHED","threadId":"t","runId":"r"}',
    )
    _patch_stream(monkeypatch, body, captured)

    await ahc.create_conversation("just text")

    assert captured["json"]["messages"][0]["content"] == "just text"


async def test_send_message_with_images_sends_content_parts(monkeypatch):
    captured: dict = {}
    body = _sse(
        '{"type":"RUN_STARTED","threadId":"t","runId":"r"}',
        '{"type":"RUN_FINISHED","threadId":"t","runId":"r"}',
    )
    _patch_stream(monkeypatch, body, captured)

    await ahc.send_message("c1", "look", images=[{"data": "ZZ", "mimeType": "image/jpeg"}])

    content = captured["json"]["messages"][0]["content"]
    assert isinstance(content, list)
    assert {"type": "image", "data": "ZZ", "mimeType": "image/jpeg"} in content


# --- multimedia (files): binary attachments -> file content parts -------------


async def test_create_conversation_with_files_sends_file_parts(monkeypatch):
    captured: dict = {}
    body = _sse(
        '{"type":"RUN_STARTED","threadId":"t","runId":"r"}',
        '{"type":"RUN_FINISHED","threadId":"t","runId":"r"}',
    )
    _patch_stream(monkeypatch, body, captured)

    await ahc.create_conversation(
        "here is a report",
        files=[{"name": "report.pdf", "data": "UERG", "mimeType": "application/pdf"}],
    )

    content = captured["json"]["messages"][0]["content"]
    assert isinstance(content, list)
    assert {"type": "text", "text": "here is a report"} in content
    assert {
        "type": "file",
        "name": "report.pdf",
        "data": "UERG",
        "mimeType": "application/pdf",
    } in content


async def test_send_message_with_files_and_images_sends_both(monkeypatch):
    captured: dict = {}
    body = _sse(
        '{"type":"RUN_STARTED","threadId":"t","runId":"r"}',
        '{"type":"RUN_FINISHED","threadId":"t","runId":"r"}',
    )
    _patch_stream(monkeypatch, body, captured)

    await ahc.send_message(
        "c1",
        "mixed",
        images=[{"data": "ZZ", "mimeType": "image/jpeg"}],
        files=[{"name": "a.zip", "data": "YWJj", "mimeType": "application/zip"}],
    )

    content = captured["json"]["messages"][0]["content"]
    assert isinstance(content, list)
    assert {"type": "image", "data": "ZZ", "mimeType": "image/jpeg"} in content
    assert {"type": "file", "name": "a.zip", "data": "YWJj", "mimeType": "application/zip"} in content


async def test_create_conversation_without_files_or_images_stays_plain(monkeypatch):
    captured: dict = {}
    body = _sse(
        '{"type":"RUN_STARTED","threadId":"t","runId":"r"}',
        '{"type":"RUN_FINISHED","threadId":"t","runId":"r"}',
    )
    _patch_stream(monkeypatch, body, captured)

    await ahc.send_message("c1", "just text")

    assert captured["json"]["messages"][0]["content"] == "just text"


async def test_create_conversation_uses_the_SERVER_assigned_id(monkeypatch):
    """webhooks must not invent the conversation id; everything downstream uses the server's."""
    captured: dict = {}
    body = b'data: {"type":"RUN_FINISHED","threadId":"t","runId":"r"}\n'
    _patch_stream(monkeypatch, body, captured)

    seen: list[str] = []

    async def on_created(cid: str) -> None:
        seen.append(cid)

    result = await ahc.create_conversation("do a thing", on_created=on_created)

    assert result is not None
    assert result["conversation_id"] == SERVER_CONV_ID
    assert seen == [SERVER_CONV_ID]
    assert captured["json"]["threadId"] == SERVER_CONV_ID
    assert "threadId" not in (captured["create_json"] or {})


async def test_create_conversation_returns_None_when_create_fails(monkeypatch):
    """No conversation means nothing to prompt."""
    streamed: list[str] = []

    def fake_stream(self, method, url, **kwargs):  # noqa: ANN001
        streamed.append(url)
        return _FakeStream(b"")

    monkeypatch.setattr(httpx.AsyncClient, "stream", fake_stream)
    _patch_create(monkeypatch, status=502, conv_id=None)

    assert await ahc.create_conversation("do a thing") is None
    assert streamed == []


# --- owner attribution ---------------------------------------------------
# The resolved owner rides the create body, since the identity header's name is deployment-specific.


async def test_create_sends_the_owner_in_the_body_not_a_hardcoded_header(monkeypatch):
    captured: dict = {}
    _patch_stream(monkeypatch, _sse('{"type":"RUN_FINISHED","threadId":"t","runId":"r"}'), captured)

    result = await ahc.create_conversation("do a thing", owner="slack-resolved-user")

    assert result is not None
    assert captured["create_json"]["owner"] == "slack-resolved-user"
    assert "x-auth-user" not in {k.lower() for k in captured["create_headers"]}


async def test_create_omits_owner_when_there_is_no_human_trigger(monkeypatch):
    captured: dict = {}
    _patch_stream(monkeypatch, _sse('{"type":"RUN_FINISHED","threadId":"t","runId":"r"}'), captured)

    await ahc.create_conversation("do a thing")

    # An empty-string owner would create a conversation owned by "", which is not unowned.
    assert "owner" not in captured["create_json"]
