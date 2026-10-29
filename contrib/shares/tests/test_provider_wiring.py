"""The provider must use the database the broker hands it and mount at the broker root.

A store that built its own StoreConfig would write where the migrations never reached,
and a prefixed mount would move every published link from /s/<uuid>/ to /shares/s/<uuid>/.
"""

from __future__ import annotations

from fastapi import FastAPI

from scooter_broker_lib.authz import NoopAuthorizer
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.store import StoreConfig
from scooter_contrib_shares.broker_provider import shares


def _context() -> BrokerContext:
    return BrokerContext(
        authorizer=NoopAuthorizer(),
        store_config=StoreConfig(dsn="sqlite+aiosqlite:///:memory:"),
    )


def test_the_provider_mounts_at_the_root():
    provider = shares(_context())
    assert provider.enabled
    assert provider.mount_at_root


def test_the_transport_serves_the_published_paths():
    provider = shares(_context())
    app = FastAPI()
    app.include_router(provider.transports[0].routes(provider, authed=lambda: None))
    paths = app.openapi()["paths"]
    assert "/shares" in paths
    assert "/s/{uuid}/" in paths
