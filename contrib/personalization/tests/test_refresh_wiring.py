"""What the refresh-profile task relies on: the /system routes, the agent-host reads,
and the analysis-only tools, which resolve the owner and the gate from the conversation."""

from __future__ import annotations

import json

import httpx
import pytest
from conftest import create_schema, sqlite_config
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from scooter_broker_lib.mcp import ToolContext
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_personalization import REFRESH_TITLE, mcp_tools
from scooter_contrib_personalization.agent_host import AgentHost, ms_to_iso
from scooter_contrib_personalization.store import PersonalizationStore, _Base
from scooter_contrib_personalization.transport import Personalization

T0 = 1_790_000_000_000  # ms epoch
CONVS = [
    {"id": "a1", "owner": "alice", "title": "Fix CI", "createdAt": T0, "lastActivityAt": T0 + 5_000},
    {"id": "a2", "owner": "alice", "title": "Old", "createdAt": T0 - 9_000, "lastActivityAt": T0 - 1_000},
    {"id": "a3", "owner": "alice", "title": REFRESH_TITLE, "createdAt": T0, "lastActivityAt": T0 + 9_000},
    {"id": "a4", "owner": "alice", "title": "sub", "parentId": "a1", "createdAt": T0, "lastActivityAt": T0 + 8_000},
    {"id": "b1", "owner": "bob", "title": "Bob's", "createdAt": T0, "lastActivityAt": T0 + 2_000},
    {"id": "n1", "title": "nobody", "createdAt": T0, "lastActivityAt": T0 + 7_000},
]


def agent_host(calls: list[str] | None = None) -> AgentHost:
    def handler(req: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(f"{req.url.path}?{req.url.query.decode()}")
        if req.url.path == "/conversations":
            return httpx.Response(200, json=CONVS)
        if req.url.path.endswith("/messages"):
            return httpx.Response(200, json={"messages": [
                {"id": "m1", "role": "user", "content": "please use nix develop"},
                {"id": "m2", "role": "tool", "content": "noise"},
                {"id": "m3", "role": "assistant", "content": "x" * 5000},
                {"id": "m4", "role": "assistant", "content": "   "},
            ]})
        conv = next((c for c in CONVS if req.url.path == f"/conversations/{c['id']}"), None)
        return httpx.Response(200, json=conv) if conv else httpx.Response(404, json={})

    return AgentHost("http://agent-host", transport=httpx.MockTransport(handler))


# --- agent-host reads ---------------------------------------------------------------

async def test_activity_is_each_owners_newest_conversation_skipping_runs_and_subagents():
    assert await agent_host().latest_activity() == {"alice": ms_to_iso(T0 + 5_000), "bob": ms_to_iso(T0 + 2_000)}


async def test_history_is_the_owners_own_conversations_after_since_newest_first():
    calls: list[str] = []
    out = await agent_host(calls).history("alice", since=ms_to_iso(T0), limit=10)
    assert [c["id"] for c in out] == ["a1"]
    assert [m["role"] for m in out[0]["messages"]] == ["user", "assistant"]
    assert out[0]["messages"][1]["text"].endswith(" …") and len(out[0]["messages"][1]["text"]) < 1600
    assert any(c.startswith("/conversations?") and "scope=all" in c for c in calls)
    assert [c["id"] for c in await agent_host().history("alice", since=None, limit=10)] == ["a1", "a2"]


# --- /system routes -----------------------------------------------------------------

@pytest.fixture
async def app():
    store = PersonalizationStore(sqlite_config())
    await create_schema(store, _Base)
    transport = Personalization(store=store)
    caller: dict[str, Identity] = {}

    async def authed() -> Identity:
        return caller["identity"]

    a = FastAPI()
    provider = Provider(name="personalization", transports=[transport], enabled=True)
    a.include_router(transport.routes(provider, authed), prefix="/personalization")
    a.state.caller, a.state.store = caller, store
    return a


def client(app, *, system: bool, relayed_user: str | None = None) -> AsyncClient:
    app.state.caller["identity"] = Identity(
        conversation_id="", namespace="ns", service_account="sa", is_system_task=system, relayed_user=relayed_user
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://broker")


async def test_system_routes_refuse_anyone_but_a_system_task(app):
    async with client(app, system=False, relayed_user="alice") as c:
        assert (await c.get("/personalization/system/eligible")).status_code == 403
        r = await c.post("/personalization/system/spawned", json={"owner": "alice", "conversation_id": "x"})
        assert r.status_code == 403


async def test_refresh_now_is_eligible_until_a_run_is_spawned(app):
    async with client(app, system=False, relayed_user="alice") as c:
        assert (await c.post("/personalization/user/refresh")).status_code == 200
    async with client(app, system=True) as c:
        assert (await c.get("/personalization/system/eligible")).json()["owners"] == ["alice"]
        r = await c.post("/personalization/system/spawned", json={"owner": "alice", "conversation_id": "a3"})
        assert r.status_code == 200
        assert (await c.get("/personalization/system/eligible")).json()["owners"] == []
    assert (await app.state.store.profile("alice")).last_run_conversation == "a3"


# --- the analysis tools -------------------------------------------------------------

def ctx(conversation_id: str, owner: str | None = None) -> ToolContext:
    return ToolContext(
        identity=Identity(conversation_id=conversation_id, namespace="ns", service_account="sa", owner=owner),
        provider=Provider(name="personalization", transports=[]),
        upstream=None,  # type: ignore[arg-type]
        links=None,  # type: ignore[arg-type]
    )


@pytest.fixture
async def tools():
    store = PersonalizationStore(sqlite_config())
    await create_schema(store, _Base)
    mcp_tools.set_store(store, agent_host())
    yield store
    mcp_tools.set_store(None)


async def test_a_sandbox_without_an_owner_claim_reads_its_owners_profile(tools):
    await tools.add_note("alice", category="preferences", note="terse", source="user")
    assert "terse" in await mcp_tools.personalization_get(ctx=ctx("a1"))
    assert "No personalization profile" in await mcp_tools.personalization_get(ctx=ctx("unknown"))


async def test_only_a_refresh_run_is_offered_the_analysis_tools(tools):
    assert await mcp_tools._is_system_conversation(ctx("a3")) is True
    assert await mcp_tools._is_system_conversation(ctx("a1")) is False
    assert await mcp_tools._is_system_conversation(ctx("unknown")) is False


async def test_history_defaults_to_after_the_last_conversation_seen(tools):
    await tools.update_profile("alice", last_conversation_seen=ms_to_iso(T0))
    out = await mcp_tools.personalization_history(ctx=ctx("a3"))
    assert [c["id"] for c in json.loads(out.text)] == ["a1"]
    everything = await mcp_tools.personalization_history(since="all", ctx=ctx("a3"))
    assert [c["id"] for c in json.loads(everything.text)] == ["a1", "a2"]
