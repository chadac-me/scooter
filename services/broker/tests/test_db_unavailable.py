"""A database outage answers 503 + Retry-After, never an unhandled ASGI exception; a real query bug stays a 500."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import exc as sa_exc

from broker.core.app import create_app
from broker.core.db_unavailable import install_db_unavailable_handler, is_db_unavailable


def _app_raising(err: BaseException) -> TestClient:
    app = FastAPI()
    install_db_unavailable_handler(app)

    @app.get("/boom")
    async def boom():
        raise err

    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize(
    "err",
    [
        sa_exc.OperationalError("SELECT 1", {}, ConnectionRefusedError("refused")),
        sa_exc.InterfaceError("SELECT 1", {}, Exception("connection is closed")),
        sa_exc.TimeoutError("QueuePool limit reached"),
        ConnectionRefusedError("refused"),
    ],
)
def test_db_outage_is_a_503_with_retry_after(err):
    resp = _app_raising(err).get("/boom")
    assert resp.status_code == 503
    assert resp.headers["retry-after"] == "5"
    assert resp.json() == {"detail": "database unavailable"}


def test_a_constraint_violation_is_still_a_500():
    err = sa_exc.IntegrityError("INSERT", {}, Exception("duplicate key"))
    assert not is_db_unavailable(err)
    assert _app_raising(err).get("/boom").status_code == 500


def test_the_real_app_installs_the_handler():
    app = create_app()
    assert sa_exc.DBAPIError in app.exception_handlers
