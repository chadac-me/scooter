"""The github handler through the real extension seam: its gating answers, and its owner lookup and resource shapes arm on import."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_contrib_github import webhooks_handler as gh


@pytest.fixture
def client():
    """A minimal app with only this contrib's router mounted."""
    app = FastAPI()
    app.include_router(gh.router)
    return TestClient(app)


def test_github_webhook_disabled(client):
    """The off toggle answers `disabled` in-route rather than unmounting."""
    with patch.object(gh, "settings") as mock_settings:
        mock_settings.github_enabled = False
        resp = client.post(
            "/webhooks/github",
            headers={"X-Github-Event": "issue_comment", "X-Hub-Signature-256": ""},
            json={},
        )
        assert resp.json()["status"] == "disabled"


def test_github_webhook_invalid_signature(client):
    with patch.object(gh, "settings") as mock_settings:
        mock_settings.github_enabled = True
        mock_settings.github_webhook_secret = "real-secret"
        resp = client.post(
            "/webhooks/github",
            headers={"X-Github-Event": "issue_comment", "X-Hub-Signature-256": "sha256=wrong"},
            json={},
        )
        assert resp.status_code == 401


def test_importing_the_handler_arms_the_owner_lookup_and_shapes():
    """identity/resources register by import side effect and nothing else imports them."""
    from scooter_webhooks_lib import identity, resources

    assert "github" in identity.registered_providers()
    assert "github" in resources.registered_sources()
