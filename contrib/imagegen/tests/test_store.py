"""GenerationStore against a real (SQLite) schema: usage counts and recording."""

from __future__ import annotations

import pytest

from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_contrib_imagegen.store import GenerationStore, _Base


@pytest.fixture
async def store() -> GenerationStore:
    s = GenerationStore(sqlite_config())
    await create_schema(s, _Base)
    return s


async def test_usage_today_is_zero_with_no_rows(store: GenerationStore):
    usage = await store.usage_today("alice")
    assert usage.total == 0
    assert usage.per_backend == {}


async def test_record_then_usage_today_counts_per_backend(store: GenerationStore):
    await store.record("alice", "bedrock", "amazon.titan-image-generator-v2:0")
    await store.record("alice", "bedrock", "amazon.titan-image-generator-v2:0")
    await store.record("alice", "openai", "gpt-image-1")
    # Someone else's generations never count against alice.
    await store.record("bob", "bedrock", "amazon.titan-image-generator-v2:0")

    usage = await store.usage_today("alice")
    assert usage.total == 3
    assert usage.per_backend == {"bedrock": 2, "openai": 1}
