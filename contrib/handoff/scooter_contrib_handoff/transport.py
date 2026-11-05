"""handoff's HTTP routes, mounted under /handoff/*.

    POST   /bundles          upload a bundle: the raw request body, any archive (sandbox)
    GET    /bundles/{id}     download it (any sandbox holding the id)
    DELETE /bundles/{id}     delete it (the uploading sandbox only)
    POST   /system/index     one search-index pass (the index system task only)

The bundle id is the capability, as a share's UUID is: it is written only into the
uploader's conversation and the handoff prompt, so it is as visible as they are.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from scooter_broker_lib.system import system_task_identity
from scooter_broker_lib.types import AuthDependency, Identity, Provider, Transport

from .agent_host import AgentHost
from .index import reindex
from .store import HandoffStore, now_utc

CHUNK_BYTES = 8 * 1024 * 1024
_MAX_DESCRIPTION = 500


def _gib(n: int) -> str:
    return f"{n / 1024**3:.2f} GiB"


@dataclass
class Handoff(Transport):
    name: str = "handoff"
    store: HandoffStore | None = field(default=None)
    agent_host: AgentHost | None = field(default=None)
    max_bundle_bytes: int = 1024**3
    quota_bytes: int = 5 * 1024**3
    # None means system_task_identity(authed); tests inject a fake.
    system: Callable[..., Awaitable[object]] | None = None

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter(tags=["handoff"])
        system = Depends(self.system or system_task_identity(authed))

        def _store() -> HandoffStore:
            if self.store is None:
                raise HTTPException(status_code=503, detail="handoff not configured")
            return self.store

        def _sandbox(identity: Identity) -> str:
            if not identity.conversation_id:
                raise HTTPException(status_code=403, detail="bundles are for sandboxes")
            return identity.conversation_id

        @router.post("/bundles", status_code=201)
        async def upload(
            request: Request, description: str = Query(default="", max_length=_MAX_DESCRIPTION),
            identity: Identity = Depends(authed),
        ) -> dict:
            store, uploader, now = _store(), _sandbox(identity), now_utc()
            declared = int(request.headers.get("content-length") or 0)
            limit = min(self.max_bundle_bytes, self.quota_bytes - await store.usage(uploader, now))
            if limit <= 0:
                raise HTTPException(status_code=413, detail=(
                    f"this sandbox already holds {_gib(self.quota_bytes)} of live bundles, the quota; "
                    "delete one with DELETE handoff/bundles/<id> or wait for one to expire"
                ))
            if declared > limit:
                raise HTTPException(status_code=413, detail=_too_big(limit, self.max_bundle_bytes))
            bundle_id = await store.begin_bundle(uploader, description or None, now)
            size, seq, digest, buf = 0, 0, hashlib.sha256(), bytearray()
            try:
                async for part in request.stream():
                    size += len(part)
                    if size > limit:
                        raise HTTPException(status_code=413, detail=_too_big(limit, self.max_bundle_bytes))
                    digest.update(part)
                    buf += part
                    while len(buf) >= CHUNK_BYTES:
                        await store.add_chunk(bundle_id, seq, bytes(buf[:CHUNK_BYTES]))
                        del buf[:CHUNK_BYTES]
                        seq += 1
                if size == 0:
                    raise HTTPException(status_code=400, detail="empty upload: pipe an archive into the request body")
                if buf:
                    await store.add_chunk(bundle_id, seq, bytes(buf))
            except BaseException:
                await store.delete_bundle(bundle_id)
                raise
            bundle = await store.finish_bundle(bundle_id, size=size, sha256=digest.hexdigest())
            return bundle.payload()

        @router.get("/bundles/{bundle_id}")
        async def download(bundle_id: str, identity: Identity = Depends(authed)) -> StreamingResponse:
            store, now = _store(), now_utc()
            _sandbox(identity)
            bundle = await store.bundle(bundle_id, now)
            if bundle is None:
                raise HTTPException(status_code=404, detail="no such bundle, or it expired")
            await store.touch_bundle(bundle_id, now)
            return StreamingResponse(
                store.chunks(bundle_id), media_type="application/octet-stream",
                headers={"content-length": str(bundle.size_bytes), "x-bundle-sha256": bundle.sha256 or ""},
            )

        @router.delete("/bundles/{bundle_id}")
        async def remove(bundle_id: str, identity: Identity = Depends(authed)) -> dict:
            if not await _store().delete_bundle(bundle_id, _sandbox(identity)):
                raise HTTPException(status_code=404, detail="no such bundle uploaded from this sandbox")
            return {"deleted": bundle_id}

        @router.post("/system/index", dependencies=[system])
        async def index() -> dict:
            if self.agent_host is None:
                raise HTTPException(status_code=503, detail="AGENT_HOST_URL is not set")
            return await reindex(_store(), self.agent_host, now_utc())

        return router


def _too_big(limit: int, max_bundle: int) -> str:
    if limit < max_bundle:
        return f"upload exceeds the {_gib(limit)} left in this sandbox's bundle quota"
    return f"upload exceeds the {_gib(max_bundle)} bundle limit; split it into several bundles"
