"""The app must hand a BrokerContext to any factory that declares a parameter, since
discover_providers skips such a factory when no context is supplied and the provider is
then silently absent.

Asserted with a probe factory registered through the real @register_provider, so
create_app() discovers it by the path a shipped provider takes; it is popped in teardown
so no phantom provider leaks into later create_app() calls.
"""

from __future__ import annotations

import pytest

from scooter_broker_lib import registry
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.whoami import WhoAmI
from scooter_broker_lib.types import Provider


@pytest.fixture
def probe():
    seen: dict = {}

    @register_provider
    def ctx_probe(ctx: BrokerContext) -> Provider:
        seen["authorizer"] = ctx.authorizer
        seen["store_config"] = ctx.store_config
        return Provider(name="ctx-probe", transports=[WhoAmI()], enabled=True)

    assert "ctx_probe" in registry._REGISTRY, "the probe did not register"
    try:
        yield seen
    finally:
        registry._REGISTRY.pop("ctx_probe", None)


def test_a_context_taking_factory_is_built_and_mounted(probe):
    from broker.core.app import create_app

    app = create_app()

    assert probe, "the factory was skipped — the app supplied no BrokerContext"
    assert probe["authorizer"] is not None
    assert probe["store_config"] is not None

    # Asserted through the OpenAPI schema, since app.routes keeps an included router opaque.
    paths = app.openapi()["paths"]
    assert any(p.startswith("/ctx-probe/") for p in paths), f"mounted: {sorted(paths)}"


def test_the_authorizer_is_the_one_the_app_built(probe, monkeypatch):
    from broker.core import app as app_mod

    sentinel = object()
    # Patched where create_app looks it up, since the name is bound at import.
    monkeypatch.setattr(app_mod, "authorizer_from_settings", lambda _s: sentinel)

    app_mod.create_app()
    assert probe["authorizer"] is sentinel
