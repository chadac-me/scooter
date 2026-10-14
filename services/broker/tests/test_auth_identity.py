"""The real authenticate() body, executed directly with a faked TokenReview so its settings reads happen for real."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from broker.core import auth as auth_mod


class _User:
    def __init__(self, username): self.username = username


class _Status:
    def __init__(self, username): self.authenticated, self.user = True, _User(username)


class _Result:
    def __init__(self, username): self.status = _Status(username)


class _Api:
    def __init__(self, username): self._u = username
    def create_token_review(self, _review): return _Result(self._u)


def _request() -> Request:
    return Request({
        "type": "http", "method": "GET", "path": "/", "headers": [(b"authorization", b"Bearer t")],
    })


@pytest.fixture
def _as(monkeypatch):
    def _install(username):
        monkeypatch.setattr(auth_mod, "_api", lambda: _Api(username))
    return _install


async def test_a_sandbox_sa_authenticates(_as, monkeypatch):
    monkeypatch.setattr(auth_mod.settings, "sandbox_namespace", "agent-sandbox")
    _as("system:serviceaccount:agent-sandbox:sandbox-conv-1")
    identity = await auth_mod.authenticate(_request())
    assert identity.conversation_id == "conv-1"
    assert not identity.is_approver


async def test_an_approver_sa_authenticates(_as, monkeypatch):
    monkeypatch.setattr(auth_mod.settings, "approver_service_accounts",
                        "system:serviceaccount:agent-sandbox:agent-host")
    _as("system:serviceaccount:agent-sandbox:agent-host")
    identity = await auth_mod.authenticate(_request())
    assert identity.is_approver
    assert identity.conversation_id == ""


async def test_a_stranger_is_rejected(_as):
    _as("system:serviceaccount:other:nobody")
    with pytest.raises(HTTPException) as e:
        await auth_mod.authenticate(_request())
    assert e.value.status_code == 403
