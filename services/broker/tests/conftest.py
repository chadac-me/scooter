"""Shared fixtures for the broker suite."""

import pytest


@pytest.fixture(autouse=True)
def _fresh_token_cache(monkeypatch):
    """Tests reuse token strings for different SAs, so each starts with an empty verdict cache."""
    from broker.core import auth

    monkeypatch.setattr(auth, "_verifier", auth.Verifier(auth._kube_review))
