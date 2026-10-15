"""The annotation store and its transport, on in-memory SQLite.

The contract these pin down is the sync one. The viewer pushes from an outbox and
retries, so the two properties that decide whether a human's comment is ever seen
are: a retry must not duplicate, and a retry must not wake the agent twice.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_broker_lib.types import Identity, Provider

from scooter_contrib_files import store as files_store
from scooter_contrib_files.annotations_transport import Annotations
from scooter_contrib_files.notify import wake_message
from scooter_contrib_files.store import Anchor, Annotation, AnnotationStore

from conftest import create_schema, sqlite_config


async def authenticate() -> Identity:  # pragma: no cover
    """Stands in for the broker's auth dependency; replaced via dependency_overrides."""
    raise AssertionError("dependency_overrides should have replaced this")


def _identity(conv: str) -> Identity:
    return Identity(
        conversation_id=conv,
        namespace="agent-sandbox",
        service_account=f"system:serviceaccount:agent-sandbox:sandbox-{conv}",
    )


@pytest.fixture
async def store():
    s = AnnotationStore(sqlite_config())
    # The store issues no DDL, so the throwaway SQLite table is built here.
    await create_schema(s, files_store._Base)
    return s


class _Wakes:
    """A stand-in for the agent-host notify that records what it was asked to send."""

    def __init__(self, accept: bool = True) -> None:
        self.calls: list[Annotation] = []
        self.accept = accept

    async def __call__(self, annotation, **kw):
        self.calls.append(annotation)
        return self.accept


def _client(store, conv="conv-alice", wakes=None):
    """The real transport, mounted the way the broker mounts it: /{provider}/annotations."""
    transport = Annotations()
    transport.set_store(store, agent_host_url="http://host", notify=wakes or _Wakes())

    app = FastAPI()
    app.include_router(
        transport.routes(Provider(name="files", transports=[transport]), authed=authenticate),
        prefix="/files",
    )
    app.dependency_overrides[authenticate] = lambda: _identity(conv)
    return TestClient(app)


def _payload(**over) -> dict:
    body = {
        "path": "/workspace/docs/design.md",
        "anchor": {"line": 41, "quote": "the quoted text still matches"},
        "kind": "comment",
        "text": "What happens when the same quote appears twice?",
    }
    body.update(over)
    return body


def _annotation(**over) -> Annotation:
    base = dict(
        id="a1",
        conversation_id="conv-alice",
        path="/workspace/docs/design.md",
        anchor=Anchor(line=41, quote="still matches"),
        kind="comment",
        text="a remark",
        thread="t1",
    )
    base.update(over)
    return Annotation(**base)


# --- store ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upsert_stores_and_reports_creation(store):
    stored, created = await store.upsert(_annotation(), now_iso="2026-01-01T00:00:00Z")
    assert created is True
    assert stored.text == "a remark" and stored.anchor.line == 41
    assert (await store.get("a1")).thread == "t1"


@pytest.mark.asyncio
async def test_repushing_the_same_id_updates_rather_than_duplicating(store):
    await store.upsert(_annotation(), now_iso="t0")
    stored, created = await store.upsert(_annotation(text="edited"), now_iso="t1")

    # The outbox retries; a second push of one remark is one remark.
    assert created is False, "a re-push must not read as a new annotation"
    assert stored.text == "edited"
    assert stored.created_at == "t0", "the original authoring time survives a re-push"
    assert stored.updated_at == "t1"
    assert len(await store.list("conv-alice")) == 1


@pytest.mark.asyncio
async def test_an_id_cannot_be_hijacked_by_another_conversation(store):
    await store.upsert(_annotation(), now_iso="t0")
    with pytest.raises(PermissionError):
        await store.upsert(_annotation(conversation_id="conv-bob", text="mine now"), now_iso="t1")
    assert (await store.get("a1")).text == "a remark"


@pytest.mark.asyncio
async def test_list_is_scoped_filtered_and_ordered(store):
    await store.upsert(_annotation(id="a1", thread="t1", created_at="2026-01-01"), now_iso="x")
    await store.upsert(
        _annotation(id="a2", thread="t1", text="reply", created_at="2026-01-02"), now_iso="x"
    )
    await store.upsert(
        _annotation(id="a3", thread="t2", path="/workspace/other.md", created_at="2026-01-03"),
        now_iso="x",
    )
    await store.upsert(
        _annotation(id="b1", conversation_id="conv-bob", created_at="2026-01-04"), now_iso="x"
    )

    mine = await store.list("conv-alice")
    assert [a.id for a in mine] == ["a1", "a2", "a3"], "oldest first, and only my conversation"
    assert [a.id for a in await store.list("conv-alice", thread="t1")] == ["a1", "a2"]
    assert [a.id for a in await store.list("conv-alice", path="/workspace/other.md")] == ["a3"]


@pytest.mark.asyncio
async def test_resolving_applies_to_the_whole_thread(store):
    await store.upsert(_annotation(id="a1", thread="t1"), now_iso="t0")
    await store.upsert(_annotation(id="a2", thread="t1"), now_iso="t0")
    await store.upsert(_annotation(id="a3", thread="t2"), now_iso="t0")

    # Resolution is a property of the discussion: a half-resolved thread has no meaning.
    assert await store.resolve_thread("conv-alice", "t1", resolved=True, now_iso="t1") == 2
    assert [a.resolved for a in await store.list("conv-alice", thread="t1")] == [True, True]
    assert [a.resolved for a in await store.list("conv-alice", thread="t2")] == [False]
    assert len(await store.list("conv-alice", resolved=False)) == 1


@pytest.mark.asyncio
async def test_resolving_another_conversations_thread_touches_nothing(store):
    await store.upsert(_annotation(id="b1", conversation_id="conv-bob", thread="t9"), now_iso="t0")
    assert await store.resolve_thread("conv-alice", "t9", resolved=True, now_iso="t1") == 0
    assert (await store.get("b1")).resolved is False


@pytest.mark.asyncio
async def test_delete_is_conversation_scoped(store):
    await store.upsert(_annotation(), now_iso="t0")
    with pytest.raises(PermissionError):
        await store.delete("a1", conversation_id="conv-bob")
    assert await store.delete("a1", conversation_id="conv-alice") is True
    assert await store.delete("a1", conversation_id="conv-alice") is False


# --- HTTP -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_put_stores_and_wakes_the_conversation(store):
    wakes = _Wakes()
    r = _client(store, wakes=wakes).put("/files/annotations/a1", json=_payload())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] is True and body["woke"] is True
    assert body["annotation"]["author"] == {"conversation": "conv-alice"}
    # A remark with no thread of its own starts one.
    assert body["annotation"]["thread"] == "a1"
    assert len(wakes.calls) == 1


@pytest.mark.asyncio
async def test_a_retried_push_does_not_wake_the_agent_again(store):
    wakes = _Wakes()
    client = _client(store, wakes=wakes)
    client.put("/files/annotations/a1", json=_payload())
    again = client.put("/files/annotations/a1", json=_payload())

    # The lost-ack case: the viewer believes the push failed and sends it again.
    # Waking here would cost a turn per retry.
    assert again.json()["created"] is False and again.json()["woke"] is False
    assert len(wakes.calls) == 1


@pytest.mark.asyncio
async def test_a_failed_wake_still_stores_the_annotation(store):
    wakes = _Wakes(accept=False)
    r = _client(store, wakes=wakes).put("/files/annotations/a1", json=_payload())

    # Stored but silent is a real state the viewer renders differently; it is not an error.
    assert r.status_code == 200 and r.json()["woke"] is False
    assert await store.get("a1") is not None


@pytest.mark.asyncio
async def test_writing_into_another_conversation_is_refused(store):
    r = _client(store).put("/files/annotations/a1", json=_payload(conversation="conv-bob"))
    assert r.status_code == 403
    assert await store.get("a1") is None


@pytest.mark.asyncio
async def test_reading_another_conversations_annotation_is_a_404(store):
    await store.upsert(_annotation(id="b1", conversation_id="conv-bob"), now_iso="t0")
    client = _client(store)
    # 404 rather than 403: whether an id exists elsewhere is not this caller's to learn.
    assert client.get("/files/annotations/b1").status_code == 404
    assert client.delete("/files/annotations/b1").status_code == 404
    assert client.get("/files/annotations").json()["annotations"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad, why",
    [
        ({"text": ""}, "empty text"),
        ({"anchor": {"quote": "q"}}, "no line"),
        ({"anchor": {"line": 0, "quote": "q"}}, "line is 1-based"),
        ({"anchor": {"line": "41", "quote": "q"}}, "line is not an integer"),
        ({"kind": "shout"}, "unknown kind"),
        ({"kind": "answer"}, "an answer with no question"),
    ],
)
async def test_bad_payloads_are_refused(store, bad, why):
    r = _client(store).put("/files/annotations/a1", json=_payload(**bad))
    assert r.status_code == 400, f"{why}: {r.text}"
    assert await store.get("a1") is None


@pytest.mark.asyncio
async def test_an_answer_carries_the_question_it_answers(store):
    r = _client(store).put(
        "/files/annotations/a1",
        json=_payload(kind="answer", question_id="q2", text="the first option"),
    )
    assert r.status_code == 200
    assert r.json()["annotation"]["question_id"] == "q2"


@pytest.mark.asyncio
async def test_resolve_thread_over_http(store):
    client = _client(store)
    client.put("/files/annotations/a1", json=_payload())
    client.put("/files/annotations/a2", json=_payload(thread="a1"))

    r = client.post("/files/annotations/threads/a1/resolve", json={"resolved": True})
    assert r.status_code == 200 and r.json()["updated"] == 2
    assert len(client.get("/files/annotations?resolved=true").json()["annotations"]) == 2
    assert client.post("/files/annotations/threads/nope/resolve").status_code == 404


def test_an_unconfigured_transport_serves_503_rather_than_crashing():
    # The provider leaves the store unset only when annotations are disabled, in
    # which case the registry drops the provider and nothing is mounted at all —
    # so this is the belt to that braces: no route may 500 for want of a store.
    transport = Annotations()
    app = FastAPI()
    app.include_router(
        transport.routes(Provider(name="files", transports=[transport]), authed=authenticate),
        prefix="/files",
    )
    app.dependency_overrides[authenticate] = lambda: _identity("conv-alice")
    assert TestClient(app).get("/files/annotations").status_code == 503


def test_the_wake_message_names_the_place_and_the_text():
    # The agent wakes into a fresh turn with no memory of the document, so "someone
    # commented" would make it re-read the file to find out where.
    msg = wake_message(
        _annotation(text="why is this a string?", anchor=Anchor(line=41, quote="kind: str"))
    )
    assert "/workspace/docs/design.md:41" in msg
    assert "kind: str" in msg
    assert "why is this a string?" in msg
