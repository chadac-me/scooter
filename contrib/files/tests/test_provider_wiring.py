"""The provider must take its database from the context and stay absent when annotations are off.

Both halves matter to a deployment: a provider that built its own StoreConfig would
write somewhere the migrations never reached, and one that mounted while disabled
would answer the viewer with a half-working surface instead of a clean 404.
"""

from __future__ import annotations

import pytest

from scooter_broker_lib.authz import NoopAuthorizer
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.store import StoreConfig


@pytest.fixture
def _settings(monkeypatch):
    """Fresh settings per test: the module-level ones were read at import time."""
    import scooter_contrib_files.broker_provider as bp
    import scooter_contrib_files.config as cfg

    def _apply(**env):
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        fresh = cfg.FilesSettings()
        monkeypatch.setattr(cfg, "settings", fresh)
        monkeypatch.setattr(bp, "settings", fresh)
        return bp

    return _apply


def _context(dsn: str) -> BrokerContext:
    return BrokerContext(authorizer=NoopAuthorizer(), store_config=StoreConfig(dsn=dsn))


def test_annotations_off_means_the_provider_is_absent(_settings):
    bp = _settings(FILES_ANNOTATIONS_ENABLED="false")
    provider = bp.files(_context("sqlite+aiosqlite:///:memory:"))

    # discover_providers() keeps only enabled providers, so the routes are not
    # mounted and the viewer's 404 reads as "not enabled here".
    assert provider.enabled is False
    assert provider.transports[0].store is None


def test_the_store_uses_the_database_the_broker_handed_it(_settings):
    bp = _settings(FILES_ANNOTATIONS_ENABLED="true")
    dsn = "sqlite+aiosqlite:///:memory:"
    provider = bp.files(_context(dsn))
    transport = provider.transports[0]

    assert provider.enabled is True and provider.name == "files"
    assert transport.store is not None
    assert transport.store._engine.url.render_as_string() == dsn
