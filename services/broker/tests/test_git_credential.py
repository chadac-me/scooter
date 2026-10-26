"""The git-credential transport via the test provider, with auth mocked."""

from __future__ import annotations

import os

os.environ["TEST_PROVIDER_ENABLED"] = "true"

from fastapi.testclient import TestClient  # noqa: E402

from broker.core.app import create_app  # noqa: E402
from broker.core.auth import authenticate  # noqa: E402
from scooter_broker_lib.types import Identity  # noqa: E402
from broker.providers.echo import (  # noqa: E402
    TEST_GIT_HOST,
    TEST_GIT_PASSWORD,
    TEST_GIT_USERNAME,
)


def _fake_identity() -> Identity:
    return Identity(
        conversation_id="conv-git1",
        namespace="agent-sandbox",
        service_account="system:serviceaccount:agent-sandbox:sandbox-conv-git1",
    )


def _client() -> TestClient:
    app = create_app()
    app.dependency_overrides[authenticate] = _fake_identity
    return TestClient(app)


def test_git_credentials_returns_the_credential_blob():
    resp = _client().get("/test/git-credentials")

    assert resp.status_code == 200
    body = resp.json()
    assert body["protocol"] == "https"
    assert body["host"] == TEST_GIT_HOST
    assert body["username"] == TEST_GIT_USERNAME
    assert body["password"] == TEST_GIT_PASSWORD


def test_git_credentials_requires_auth():
    # Without the dependency override the real authenticate runs.
    app = create_app()
    resp = TestClient(app).get("/test/git-credentials")
    assert resp.status_code in (401, 403)


def test_test_provider_mounts_git_credentials():
    # Asserted by hitting the route, since app.routes keeps an included router opaque.
    app = create_app()
    resp = TestClient(app).get("/test/git-credentials")
    assert resp.status_code != 404


def test_forge_proxy_stops_serving_git_credentials(monkeypatch):
    # The forge proxy exists so the token never reaches the sandbox; the old route would undo that.
    monkeypatch.setenv("FORGE_PROXY_ENABLED", "true")
    app = create_app()
    app.dependency_overrides[authenticate] = _fake_identity
    assert TestClient(app).get("/test/git-credentials").status_code == 404
