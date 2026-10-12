"""The jira handler through the real extension seam: discovery finds it, its route mounts, its gating answers, and its resource shapes arm on import."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_contrib_jira import CONTRIB_NAME
from scooter_contrib_jira import webhooks_handler as jira_h


@pytest.fixture
def client():
    """A minimal app with only this contrib's router mounted."""
    app = FastAPI()
    app.include_router(jira_h.router)
    return TestClient(app)


def test_entrypoints_declared():
    from importlib.metadata import entry_points

    broker_eps = {ep.name: ep.value for ep in entry_points(group="agent_broker.providers")}
    webhook_eps = {ep.name: ep.value for ep in entry_points(group="scooter_webhooks.handlers")}
    assert broker_eps.get("jira") == "scooter_contrib_jira.broker_provider:jira"
    assert webhook_eps.get("jira") == "scooter_contrib_jira.webhooks_handler:jira"


def test_webhooks_discovers_jira_via_entrypoint():
    from scooter_webhooks_lib.registry import discover_webhooks

    handlers = {h.name: h for h in discover_webhooks()}
    assert CONTRIB_NAME in handlers
    paths = {r.path for r in handlers[CONTRIB_NAME].router.routes}
    assert "/webhooks/jira" in paths


def test_jira_webhook_disabled(client):
    """The off toggle answers `disabled` in-route rather than unmounting."""
    with patch.object(jira_h, "settings") as mock_settings:
        mock_settings.jira_enabled = False
        resp = client.post("/webhooks/jira", json={})
        assert resp.json()["status"] == "disabled"


def test_importing_the_handler_arms_the_resource_shapes():
    """Shapes register by import side effect and nothing else imports them."""
    from scooter_webhooks_lib import resources

    assert "jira" in resources.registered_sources()


async def test_jira_ack_posts_before_the_run():
    """The 'Scooter is on it' ack posts inside the `on_created` hook, before the agent run."""
    order: list[str] = []

    async def rec_post(*a, **k):
        order.append("ack")

    async def fake_create(*args, on_created=None, **kwargs):
        if on_created is not None:
            await on_created("conv-xyz")
        order.append("run")
        return {"conversation_id": "conv-xyz", "result": "done"}

    # AsyncMock for `db` so every store call is awaitable.
    with (
        patch.object(jira_h, "db", new=AsyncMock()),
        patch.object(jira_h, "create_conversation", fake_create),
        patch.object(jira_h, "push_link", new=AsyncMock()),
        patch.object(jira_h, "post_jira_comment", side_effect=rec_post) as post,
        patch.object(jira_h, "conversation_url", lambda cid: f"https://ui/?thread={cid}"),
    ):
        await jira_h._background_create_conversation(
            issue_key="ENG-1", message="hi", conv_title="t",
        )

    assert order == ["ack", "run"]
    assert "conv-xyz" in post.call_args.kwargs["body"]
