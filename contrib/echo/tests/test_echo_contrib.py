"""Integration tests for the reference echo contrib: the entry points are declared, the real registries discover the contrib through them, and each half mounts a route."""

from __future__ import annotations

from importlib.metadata import entry_points

from scooter_contrib_echo import CONTRIB_NAME


def test_entrypoints_declared():
    """Both entry-point groups advertise the echo contrib."""
    broker_eps = {ep.name: ep.value for ep in entry_points(group="agent_broker.providers")}
    webhook_eps = {ep.name: ep.value for ep in entry_points(group="scooter_webhooks.handlers")}
    assert broker_eps.get("echo") == "scooter_contrib_echo.broker_provider:echo"
    assert webhook_eps.get("echo") == "scooter_contrib_echo.webhooks_handler:echo"


def test_broker_discovers_echo_via_entrypoint():
    """The broker's real discovery loads the contrib through the entry point."""
    from scooter_broker_lib.registry import discover_providers

    providers = {p.name: p for p in discover_providers()}
    assert CONTRIB_NAME in providers
    echo = providers[CONTRIB_NAME]
    router = echo.transports[0].routes(echo, authed=_noop_auth)
    paths = {r.path for r in router.routes}
    assert "/ping" in paths


def test_webhooks_discovers_echo_via_entrypoint():
    """The webhooks service's real discovery loads the contrib handler."""
    from scooter_webhooks_lib.registry import discover_webhooks

    handlers = {h.name: h for h in discover_webhooks()}
    assert CONTRIB_NAME in handlers
    paths = {r.path for r in handlers[CONTRIB_NAME].router.routes}
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
