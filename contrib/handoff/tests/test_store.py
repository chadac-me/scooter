from __future__ import annotations

from datetime import timedelta

from conftest import NOW


async def _bundle(store, uploader: str, data: bytes, now=NOW) -> str:
    bid = await store.begin_bundle(uploader, None, now)
    await store.add_chunk(bid, 0, data)
    await store.finish_bundle(bid, size=len(data), sha256="x")
    return bid


async def test_a_bundle_round_trips_in_order(store):
    bid = await store.begin_bundle("sbx-a", "repo", NOW)
    for i, part in enumerate([b"one-", b"two-", b"three"]):
        await store.add_chunk(bid, i, part)
    assert await store.bundle(bid, NOW) is None, "an unfinished upload is not downloadable"
    await store.finish_bundle(bid, size=13, sha256="abc")
    bundle = await store.bundle(bid, NOW)
    assert bundle.size_bytes == 13 and bundle.description == "repo"
    assert b"".join([c async for c in store.chunks(bid)]) == b"one-two-three"


async def test_bundle_ids_are_unguessable(store):
    a, b = await _bundle(store, "sbx-a", b"x"), await _bundle(store, "sbx-a", b"x")
    assert a != b and a.startswith("b_") and len(a) > 20


async def test_expiry_and_touch(store):
    bid = await _bundle(store, "sbx-a", b"x")
    assert await store.bundle(bid, NOW + timedelta(days=15)) is None
    await store.touch_bundle(bid, NOW + timedelta(days=10))
    assert await store.bundle(bid, NOW + timedelta(days=15)) is not None


async def test_usage_counts_live_and_in_flight_bytes(store):
    await _bundle(store, "sbx-a", b"12345")
    pending = await store.begin_bundle("sbx-a", None, NOW)
    await store.add_chunk(pending, 0, b"123")
    await _bundle(store, "sbx-b", b"1234567")
    assert await store.usage("sbx-a", NOW) == 8
    assert await store.usage("sbx-a", NOW + timedelta(days=15)) == 3, "expired bundles free their quota"


async def test_only_the_uploader_deletes(store):
    bid = await _bundle(store, "sbx-a", b"x")
    assert not await store.delete_bundle(bid, "sbx-b")
    assert await store.delete_bundle(bid, "sbx-a")
    assert await store.bundle(bid, NOW) is None
    assert [c async for c in store.chunks(bid)] == []


async def test_purge_drops_expired_and_abandoned(store):
    live = await _bundle(store, "sbx-a", b"x")
    old = await _bundle(store, "sbx-a", b"x", now=NOW - timedelta(days=20))
    abandoned = await store.begin_bundle("sbx-a", None, NOW - timedelta(days=1))
    fresh_upload = await store.begin_bundle("sbx-a", None, NOW)
    assert await store.purge_bundles(NOW) == 2
    assert await store.bundle(live, NOW) is not None
    assert await store.bundle(old, NOW) is None
    assert await store.delete_bundle(fresh_upload) and not await store.delete_bundle(abandoned)


async def test_search_ranks_one_hit_per_conversation(store):
    await store.replace_conversation("c1", title="Router 503s", owner="alice", last_activity_at=10, messages=[
        ("user", "why does the router return 503 during deploys"),
        ("assistant", "the router 503 comes from no ready pod"),
    ])
    await store.replace_conversation("c2", title="Unrelated", owner="bob", last_activity_at=20, messages=[
        ("user", "the router is fine"),
    ])
    hits = await store.search("router 503", 10)
    assert [h.conversation_id for h in hits] == ["c1"]
    assert "503" in hits[0].snippet and hits[0].title == "Router 503s"
    assert [h.conversation_id for h in await store.search("router", 10)] == ["c1", "c2"], "title match first"
    assert await store.search("router", 10, exclude={"c1", "c2"}) == []


async def test_replace_swaps_messages_and_remove_forgets(store):
    await store.replace_conversation("c1", title="t", owner=None, last_activity_at=1, messages=[("user", "alpha")])
    await store.replace_conversation("c1", title="t", owner=None, last_activity_at=2, messages=[("user", "beta")])
    assert await store.search("alpha", 5) == []
    assert await store.indexed() == {"c1": 2}
    await store.remove_conversations(["c1"])
    assert await store.indexed() == {} and await store.search("beta", 5) == []
