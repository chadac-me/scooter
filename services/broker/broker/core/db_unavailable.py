"""Map a database outage to 503 + Retry-After instead of an unhandled ASGI exception."""

from __future__ import annotations

import logging
import socket

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import exc as sa_exc

logger = logging.getLogger(__name__)

RETRY_AFTER_SECONDS = 5


def is_db_unavailable(err: BaseException) -> bool:
    """Whether `err` means the database could not be reached, as opposed to a bad query or constraint."""
    if isinstance(err, sa_exc.DBAPIError) and err.connection_invalidated:
        return True
    # A pool checkout timeout, or the driver failing to connect or losing the connection.
    if isinstance(err, (sa_exc.TimeoutError, sa_exc.OperationalError, sa_exc.InterfaceError)):
        return True
    # asyncpg's connect errors are not always wrapped by SQLAlchemy.
    return isinstance(err, (ConnectionError, socket.gaierror))


def install_db_unavailable_handler(app: FastAPI) -> None:
    async def handler(request: Request, err: Exception):
        if not is_db_unavailable(err):
            raise err  # a real bug stays a 500
        logger.warning(
            "database unavailable; answering 503",
            extra={"path": request.url.path, "error": f"{type(err).__name__}: {err}"},
        )
        return JSONResponse(
            {"detail": "database unavailable"},
            status_code=503,
            headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
        )

    for cls in (sa_exc.DBAPIError, sa_exc.TimeoutError, sa_exc.InterfaceError, ConnectionError, socket.gaierror):
        app.add_exception_handler(cls, handler)
