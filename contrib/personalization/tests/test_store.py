from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from conftest import create_schema, sqlite_config
from scooter_contrib_personalization.store import PersonalizationStore, ProtectedNote, _Base

NOW = datetime(2026, 10, 17, tzinfo=timezone.utc)
TEN_DAYS = timedelta(days=10)


@pytest.fixture
async def store():
    s = PersonalizationStore(sqlite_config())
    await create_schema(s, _Base)
    return s


def iso(days_ago: float) -> str:
    return (NOW - timedelta(days=days_ago)).isoformat()


async def test_a_user_with_no_row_is_enabled(store):
    assert (await store.profile("alice")).enabled is True


async def test_a_user_edit_turns_an_agent_note_into_a_user_note(store):
    n = await store.add_note("alice", category="preferences", note="terse", source="agent")
    edited = await store.update_note("alice", n.id, as_agent=False, note="very terse")
    assert edited.source == "user"


async def test_the_agent_cannot_touch_user_or_pinned_notes(store):
    user = await store.add_note("alice", category="preferences", note="mine", source="user")
    pinned = await store.add_note("alice", category="preferences", note="p", source="agent", pinned=True)
    for note in (user, pinned):
        with pytest.raises(ProtectedNote):
            await store.update_note("alice", note.id, as_agent=True, note="x")
        with pytest.raises(ProtectedNote):
            await store.delete_note("alice", note.id, as_agent=True)


async def test_another_owners_note_is_invisible(store):
    n = await store.add_note("alice", category="preferences", note="x", source="user")
    assert await store.update_note("bob", n.id, as_agent=False, note="y") is None
    assert await store.delete_note("bob", n.id, as_agent=False) is False


async def test_eligibility(store):
    # Never analysed, has activity: due.
    # Analysed recently: not due. Analysed long ago but nothing new: not due.
    # Disabled: never due. Requested: due first, regardless of interval.
    await store.update_profile("recent", last_analyzed_at=iso(2))
    await store.update_profile("stale-quiet", last_analyzed_at=iso(20), last_conversation_seen=iso(15))
    await store.update_profile("stale-active", last_analyzed_at=iso(20), last_conversation_seen=iso(15))
    await store.update_profile("off", enabled=False)
    await store.update_profile("asked", last_analyzed_at=iso(1), refresh_requested_at=iso(0.1))
    activity = {
        "new": iso(1), "recent": iso(1), "stale-quiet": iso(15),
        "stale-active": iso(3), "off": iso(1),
    }
    due = await store.eligible(interval=TEN_DAYS, limit=10, latest_activity=activity, now=NOW)
    assert due == ["asked", "new", "stale-active"]
    assert await store.eligible(interval=TEN_DAYS, limit=1, latest_activity=activity, now=NOW) == ["asked"]
