"""Integration tests for the reference echo contrib: the real registries discover the contrib through them, and each half mounts a route."""

from __future__ import annotations

def test_broker_discovers_echo_via_entrypoint():
    """The broker's real discovery loads the contrib through the entry point."""
    from scooter_broker_lib.registry import discover_providers

    providers = {p.name: p for p in discover_providers()}
    assert "echo" in providers
    echo = providers["echo"]
    router = echo.transports[0].routes(echo, authed=_noop_auth)
    paths = {r.path for r in router.routes}
    assert "/ping" in paths


def test_webhooks_discovers_echo_via_entrypoint():
    """The webhooks service's real discovery loads the contrib handler."""
    from scooter_webhooks_lib.registry import discover_webhooks

    handlers = {h.name: h for h in discover_webhooks()}
    assert "echo" in handlers
    paths = {r.path for r in handlers["echo"].router.routes}
    assert "/webhooks/echo" in paths


async def _noop_auth():  # pragma: no cover
    from scooter_broker_lib.types import Identity

    return Identity(
        conversation_id="test",
        namespace="test",
        service_account="system:serviceaccount:test:sandbox-test",
    )


def _client(identity):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from scooter_contrib_echo.broker_provider import echo

    async def authed():
        return identity

    provider = echo()
    app = FastAPI()
    app.include_router(provider.transports[0].routes(provider, authed=authed), prefix="/echo")
    return TestClient(app)


def test_user_whoami_returns_the_relayed_user():
    """The settings tab's round-trip answers with the user the relay named."""
    from scooter_broker_lib.types import Identity

    ident = Identity(conversation_id="", namespace="ns", service_account="host", relayed_user="alice")
    res = _client(ident).get("/echo/user/whoami")
    assert res.status_code == 200
    assert res.json() == {"provider": "echo", "user": "alice"}


def test_user_whoami_refuses_a_sandbox():
    """A sandbox's own header names nobody: the core never sets relayed_user for it."""
    from scooter_broker_lib.types import Identity

    ident = Identity(conversation_id="c1", namespace="ns", service_account="sandbox-c1")
    res = _client(ident).get("/echo/user/whoami", headers={"X-Scooter-User": "alice"})
    assert res.status_code == 403
