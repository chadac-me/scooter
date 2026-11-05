"""The /handoff/bundles routes: stream in, stream out, quota and size limits, uploader-only delete."""

from __future__ import annotations

import hashlib

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from scooter_broker_lib.types import Identity, Provider

from scooter_contrib_handoff import transport as transport_mod
from scooter_contrib_handoff.transport import Handoff


@pytest.fixture
def make_app(store, agent_host, monkeypatch):
    monkeypatch.setattr(transport_mod, "CHUNK_BYTES", 4)

    def make(**kw) -> FastAPI:
        t = Handoff(store=store, agent_host=agent_host, **kw)
        caller: dict[str, Identity] = {}

        async def authed() -> Identity:
            return caller["identity"]

        async def system() -> object:
            if not caller["identity"].is_system_task:
                from fastapi import HTTPException
                raise HTTPException(status_code=403)
            return caller["identity"]

        t.system = system
        a = FastAPI()
        a.include_router(t.routes(Provider(name="handoff", transports=[t], enabled=True), authed), prefix="/handoff")
        a.state.caller = caller
        return a

    return make


def as_(app, sandbox: str, *, system: bool = False) -> AsyncClient:
    app.state.caller["identity"] = Identity(
        conversation_id=sandbox, namespace="ns", service_account=f"sandbox-{sandbox}", is_system_task=system,
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://broker")


async def test_upload_then_download_from_another_sandbox(make_app):
    app = make_app()
    data = b"a tarball, chunked across several rows"
    async with as_(app, "sbx-a") as c:
        r = await c.post("/handoff/bundles", params={"description": "repo"}, content=data)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["bytes"] == len(data) and body["sha256"] == hashlib.sha256(data).hexdigest()
    async with as_(app, "sbx-b") as c:
        got = await c.get(f"/handoff/bundles/{body['id']}")
    assert got.status_code == 200 and got.content == data
    assert got.headers["x-bundle-sha256"] == body["sha256"]


async def test_unknown_bundle_is_404(make_app):
    async with as_(make_app(), "sbx-a") as c:
        assert (await c.get("/handoff/bundles/b_nope")).status_code == 404


async def test_a_caller_without_a_sandbox_is_refused(make_app):
    async with as_(make_app(), "") as c:
        assert (await c.post("/handoff/bundles", content=b"x")).status_code == 403


async def test_empty_upload_is_refused_and_leaves_nothing(make_app, store):
    async with as_(make_app(), "sbx-a") as c:
        assert (await c.post("/handoff/bundles", content=b"")).status_code == 400
    assert await store.usage("sbx-a", transport_mod.now_utc()) == 0


async def test_oversize_upload_names_the_limit_and_is_discarded(make_app, store):
    app = make_app(max_bundle_bytes=10)
    async with as_(app, "sbx-a") as c:
        r = await c.post("/handoff/bundles", content=b"x" * 11)
    assert r.status_code == 413 and "bundle limit" in r.json()["detail"]
    assert await store.usage("sbx-a", transport_mod.now_utc()) == 0


async def test_quota_is_per_sandbox(make_app):
    app = make_app(max_bundle_bytes=10, quota_bytes=12)
    async with as_(app, "sbx-a") as c:
        assert (await c.post("/handoff/bundles", content=b"x" * 10)).status_code == 201
        r = await c.post("/handoff/bundles", content=b"x" * 5)
        assert r.status_code == 413 and "quota" in r.json()["detail"]
    async with as_(app, "sbx-b") as c:
        assert (await c.post("/handoff/bundles", content=b"x" * 10)).status_code == 201


async def test_only_the_uploader_deletes(make_app):
    app = make_app()
    async with as_(app, "sbx-a") as c:
        bid = (await c.post("/handoff/bundles", content=b"data")).json()["id"]
    async with as_(app, "sbx-b") as c:
        assert (await c.delete(f"/handoff/bundles/{bid}")).status_code == 404
    async with as_(app, "sbx-a") as c:
        assert (await c.delete(f"/handoff/bundles/{bid}")).status_code == 200
        assert (await c.get(f"/handoff/bundles/{bid}")).status_code == 404


async def test_index_is_for_the_system_task_only(make_app, router):
    app = make_app()
    router.add("c1", messages=[("user", "hello")])
    async with as_(app, "sbx-a") as c:
        assert (await c.post("/handoff/system/index")).status_code == 403
    async with as_(app, "", system=True) as c:
        r = await c.post("/handoff/system/index")
    assert r.status_code == 200 and r.json()["indexed"] == 1
