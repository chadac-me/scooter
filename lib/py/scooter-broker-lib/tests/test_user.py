"""user_identity: a contrib's /user/* routes see the relayed user and refuse everyone else."""

from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.testclient import TestClient

from scooter_broker_lib.types import Identity
from scooter_broker_lib.user import user_identity


def _app(identity: Identity) -> TestClient:
    async def authed(request: Request) -> Identity:
        return identity

    router = APIRouter()
    user = user_identity(authed)

    @router.get("/user/me")
    async def me(user_id: str = Depends(user)) -> dict[str, str]:
        return {"user": user_id}

    app = FastAPI()
    app.include_router(router, prefix="/echo")
    return TestClient(app)


def test_the_relayed_user_reaches_the_route():
    ident = Identity(conversation_id="", namespace="ns", service_account="host", relayed_user="alice")
    res = _app(ident).get("/echo/user/me")
    assert res.status_code == 200
    assert res.json() == {"user": "alice"}


def test_a_sandbox_is_refused():
    ident = Identity(conversation_id="c1", namespace="ns", service_account="sandbox-c1")
    res = _app(ident).get("/echo/user/me", headers={"X-Scooter-User": "alice"})
    assert res.status_code == 403


def test_an_approver_without_a_user_is_refused():
    ident = Identity(conversation_id="", namespace="ns", service_account="host", is_approver=True)
    assert _app(ident).get("/echo/user/me").status_code == 403
