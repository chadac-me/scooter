"""The whoami transport and registry via the test provider, with auth mocked."""

from __future__ import annotations

import os

os.environ["TEST_PROVIDER_ENABLED"] = "true"

from fastapi.testclient import TestClient  # noqa: E402

from broker.core.app import create_app  # noqa: E402
from broker.core.auth import authenticate  # noqa: E402
from scooter_broker_lib.types import Identity  # noqa: E402
from broker.providers.echo import recorder  # noqa: E402


def _fake_identity() -> Identity:
    return Identity(
        conversation_id="conv-abc123",
        namespace="agent-sandbox",
        service_account="system:serviceaccount:agent-sandbox:sandbox-conv-abc123",
    )


def _client() -> TestClient:
    app = create_app()
    app.dependency_overrides[authenticate] = _fake_identity
    return TestClient(app)


def test_whoami_returns_validated_identity():
    recorder.calls.clear()
    client = _client()

    resp = client.get("/test/whoami")

    assert resp.status_code == 200
    body = resp.json()
    assert body["conversation_id"] == "conv-abc123"
    assert body["namespace"] == "agent-sandbox"
    assert body["service_account"].endswith("sandbox-conv-abc123")


def test_whoami_records_the_call():
    recorder.calls.clear()
    client = _client()

    client.get("/test/whoami")

    assert len(recorder.calls) == 1
    assert recorder.calls[0].conversation_id == "conv-abc123"


def test_test_provider_mounts_whoami():
    # Asserted by hitting the route, since app.routes keeps an included router opaque.
    app = create_app()
    resp = TestClient(app).get("/test/whoami")
    assert resp.status_code != 404
