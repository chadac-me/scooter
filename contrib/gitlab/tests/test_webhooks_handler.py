"""The gitlab handler through the real extension seam: its gating answers, and its owner lookup and resource shapes arm on import."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_contrib_gitlab import webhooks_handler as gitlab_h


@pytest.fixture
def client():
    """A minimal app with only this contrib's router mounted."""
    app = FastAPI()
    app.include_router(gitlab_h.router)
    return TestClient(app)


def test_gitlab_webhook_disabled(client):
    """The off toggle answers `disabled` in-route rather than unmounting."""
    with patch.object(gitlab_h, "settings") as mock_settings:
        mock_settings.gitlab_enabled = False
        resp = client.post(
            "/webhooks/gitlab",
            headers={"X-Gitlab-Event": "Note Hook", "X-Gitlab-Token": ""},
            json={},
        )
        assert resp.json()["status"] == "disabled"


def test_gitlab_webhook_invalid_token(client):
    with patch.object(gitlab_h, "settings") as mock_settings:
        mock_settings.gitlab_enabled = True
        mock_settings.gitlab_webhook_secret = "real-secret"
        resp = client.post(
            "/webhooks/gitlab",
            headers={"X-Gitlab-Event": "Note Hook", "X-Gitlab-Token": "wrong"},
            json={},
        )
        assert resp.status_code == 401


def test_importing_the_handler_arms_the_owner_lookup_and_shapes():
    """identity/resources register by import side effect and nothing else imports them."""
    from scooter_webhooks_lib import identity, resources

    assert "gitlab" in identity.registered_providers()
    assert "gitlab" in resources.registered_sources()


def test_a_forwarded_note_asks_to_react_and_plan_and_carries_its_id():
    msg = gitlab_h._format_forwarded_message(
        "@chadac commented:\n\nplease fix", 7, "merge_requests", 3, has_mention=True, note_id=1234,
    )
    assert "React with an emoji first" in msg
    assert "comment your plan" in msg
    assert "note_id: 1234" in msg


def test_a_label_trigger_has_no_note_to_react_to():
    text = gitlab_h._response_instructions("issues", 3)
    assert "React" not in text
    assert "note_id" not in text
    assert "comment your plan" in text
