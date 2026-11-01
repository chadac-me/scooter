"""The user sets their identity freely; an agent fills in an empty one, only in the owner's private conversation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from scooter_broker_lib.mcp import ToolContext, gate_for
from scooter_broker_lib.owner import OwnerResolver
from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_commits import mcp_tools
from scooter_contrib_commits.store import CommitIdentityStore, _Base
from scooter_contrib_commits.transport import Commits

VIEWS = {
    "alice-private": {"owner": "alice", "visibility": "private"},
    "alice-shared": {"owner": "alice", "visibility": "shared"},
}


async def fetch(conv: str):
    return VIEWS.get(conv)


@pytest.fixture
async def store():
    s = CommitIdentityStore(sqlite_config())
    await create_schema(s, _Base)
    mcp_tools.configure(s, OwnerResolver(fetch, ttl=0))
    yield s
    mcp_tools.configure(None, None)


@pytest.fixture
def app(store):
    transport = Commits(store=store)
    caller: dict[str, Identity] = {}

    async def authed() -> Identity:
        return caller["identity"]

    a = FastAPI()
    a.include_router(transport.routes(Provider(name="commits", transports=[transport]), authed), prefix="/commits")
    a.state.caller = caller
    return a


def as_(app, relayed_user: str | None, conversation: str = "") -> AsyncClient:
    app.state.caller["identity"] = Identity(
        conversation_id=conversation, namespace="ns", service_account="agent-host", relayed_user=relayed_user
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://broker")


@dataclass
class _Links:
    async def list(self) -> list[dict[str, Any]]:
        return []


def ctx(conversation: str) -> ToolContext:
    return ToolContext(
        identity=Identity(conversation_id=conversation, namespace="agent-sandbox", service_account="sandbox"),
        provider=Provider(name="commits", transports=[]),
        upstream=None,  # type: ignore[arg-type]
        links=_Links(),
    )


async def test_only_the_relay_reaches_the_user_routes(app):
    async with as_(app, None, "alice-private") as c:
        for method in ("GET", "PUT", "DELETE"):
            r = await c.request(method, "/commits/user/identity", json={"name": "x", "email": "x@y"})
            assert r.status_code == 403, (method, r.text)


async def test_the_user_sets_replaces_and_clears(app):
    async with as_(app, "alice") as c:
        assert (await c.get("/commits/user/identity")).json() == {"identity": None}
        r = await c.put("/commits/user/identity", json={"name": "Alice", "email": "alice@example.com"})
        assert r.json()["identity"]["set_by"] == "user"
        await c.put("/commits/user/identity", json={"name": "A. Liddell", "email": "al@example.com"})
        assert (await c.get("/commits/user/identity")).json()["identity"]["email"] == "al@example.com"
        await c.delete("/commits/user/identity")
        assert (await c.get("/commits/user/identity")).json() == {"identity": None}
    async with as_(app, "bob") as c:
        assert (await c.get("/commits/user/identity")).json() == {"identity": None}


@pytest.mark.parametrize("name,email", [("", "a@b"), ("A <x>", "a@b"), ("A\nB", "a@b"), ("A", "nope"), ("A", "a b@c")])
async def test_a_malformed_identity_is_refused(app, name, email):
    async with as_(app, "alice") as c:
        assert (await c.put("/commits/user/identity", json={"name": name, "email": email})).status_code == 400


async def test_tools_are_listed_only_in_the_owners_private_conversation(store):
    for tool in ("commit_identity_get", "commit_identity_propose"):
        gate = gate_for(tool)
        assert gate is not None
        assert await gate(ctx("alice-private"))
        assert not await gate(ctx("alice-shared"))
        assert not await gate(ctx("unknown"))


async def test_an_agent_fills_in_an_empty_identity_once(store):
    got = await mcp_tools.commit_identity_propose(name="Alice", email="alice@example.com", ctx=ctx("alice-private"))
    assert not got.is_error, got.text
    assert (await store.get("alice")).set_by == "agent"
    again = await mcp_tools.commit_identity_propose(name="Mallory", email="m@evil.example", ctx=ctx("alice-private"))
    assert again.is_error and "already set" in again.text
    assert (await store.get("alice")).person.email == "alice@example.com"


async def test_an_agent_cannot_override_the_users_choice(app, store):
    async with as_(app, "alice") as c:
        await c.put("/commits/user/identity", json={"name": "Alice", "email": "alice@example.com"})
    got = await mcp_tools.commit_identity_propose(name="Other", email="o@example.com", ctx=ctx("alice-private"))
    assert got.is_error
    assert (await store.get("alice")).set_by == "user"


async def test_the_user_can_replace_an_agents_guess(app, store):
    await mcp_tools.commit_identity_propose(name="Guess", email="g@example.com", ctx=ctx("alice-private"))
    async with as_(app, "alice") as c:
        await c.put("/commits/user/identity", json={"name": "Alice", "email": "alice@example.com"})
    assert (await store.get("alice")).set_by == "user"


async def test_a_shared_conversation_cannot_propose(store):
    got = await mcp_tools.commit_identity_propose(name="Alice", email="a@example.com", ctx=ctx("alice-shared"))
    assert got.is_error
    assert await store.get("alice") is None
