"""system_task_identity: a contrib's /system/* routes admit a system task and refuse everyone else."""

from __future__ import annotations

import pytest
from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.testclient import TestClient

from scooter_broker_lib.system import system_task_identity
from scooter_broker_lib.types import Identity


def _app(identity: Identity) -> TestClient:
    async def authed(request: Request) -> Identity:
        return identity

    router = APIRouter()

    @router.get("/system/ping", dependencies=[Depends(system_task_identity(authed))])
    async def ping() -> dict[str, bool]:
        return {"ok": True}

    app = FastAPI()
    app.include_router(router, prefix="/echo")
    return TestClient(app)


def test_a_system_task_reaches_the_route():
    ident = Identity(conversation_id="", namespace="ns", service_account="scheduler", is_system_task=True)
    assert _app(ident).get("/echo/system/ping").json() == {"ok": True}


@pytest.mark.parametrize("ident", [
    Identity(conversation_id="c1", namespace="ns", service_account="sandbox-c1"),
    Identity(conversation_id="", namespace="ns", service_account="host", is_approver=True),
    Identity(conversation_id="", namespace="ns", service_account="host", relayed_user="alice"),
])
def test_everyone_else_is_refused(ident):
    assert _app(ident).get("/echo/system/ping").status_code == 403
