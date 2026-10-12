"""Integration tests for the reference echo contrib: the entry points are declared, the real registries discover the contrib through them, and each half mounts a route."""

from __future__ import annotations

from importlib.metadata import entry_points

from scooter_contrib_echo import CONTRIB_NAME


def test_entrypoints_declared():
    """Both entry-point groups advertise the echo contrib."""
    broker_eps = {ep.name: ep.value for ep in entry_points(group="agent_broker.providers")}
    webhook_eps = {ep.name: ep.value for ep in entry_points(group="scooter_webhooks.handlers")}
    assert broker_eps.get("echo") == "scooter_contrib_echo.broker_provider:echo_contrib"
    assert webhook_eps.get("echo") == "scooter_contrib_echo.webhooks_handler:echo_contrib"


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
