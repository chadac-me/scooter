"""The app side of handler discovery: the built-in handlers self-register and app.py mounts whatever is discovered, while the registry mechanism itself is tested in the lib."""

from fastapi import APIRouter

from webhooks import handlers

from scooter_webhooks_lib.registry import (
    WebhookHandler,
    discover_webhooks,
    register_webhook,
)


BUILTIN_HANDLERS = {"test"}


def test_discovers_all_builtin_handlers():
    """Every built-in handler module self-registers and is discovered."""
    names = {h.name for h in discover_webhooks([handlers])}
    assert BUILTIN_HANDLERS <= names


def test_every_discovered_handler_has_a_router():
    for h in discover_webhooks([handlers]):
        assert isinstance(h, WebhookHandler)
        assert isinstance(h.router, APIRouter)


def test_app_mounts_discovered_routes():
    """The app wires each discovered router, asserted through the OpenAPI path map since it is stable across FastAPI versions."""
    from webhooks.app import app

    paths = set(app.openapi()["paths"].keys())
    for expected in (
        "/webhooks/test",
    ):
        assert expected in paths


def test_disabled_handler_is_omitted_from_discovery():
    """A handler whose factory reports enabled=False is not returned."""

    @register_webhook
    def _disabled_probe() -> WebhookHandler:  # noqa: D401
        return WebhookHandler(name="_disabled_probe", router=APIRouter(), enabled=False)

    names = {h.name for h in discover_webhooks([handlers])}
    assert "_disabled_probe" not in names


def test_failing_factory_is_skipped_not_fatal():
    """One handler whose factory raises must not take down discovery of the rest."""

    @register_webhook
    def _boom() -> WebhookHandler:
        raise RuntimeError("factory blew up")

    names = {h.name for h in discover_webhooks([handlers])}
    assert BUILTIN_HANDLERS <= names
    assert "_boom" not in names
