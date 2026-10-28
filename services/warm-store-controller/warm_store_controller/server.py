"""The controller's HTTP face: `POST /reserve`, plus probes that make only the leader Ready."""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .reserve import Result

logger = logging.getLogger("server")

AUTH_CACHE_SECONDS = 300.0


class TokenAuth:
    """Accepts a bearer token TokenReview binds to `audience` and one of `subjects`."""

    def __init__(
        self,
        review: Callable[[str, str], str | None],
        audience: str,
        subjects: set[str],
        clock=time,
    ) -> None:
        self._review = review
        self._audience = audience
        self._subjects = subjects
        self._clock = clock
        self._lock = threading.Lock()
        self._ok: dict[str, float] = {}

    def allowed(self, header: str | None) -> bool:
        if not header or not header.startswith("Bearer "):
            return False
        token = header[len("Bearer "):].strip()
        key = hashlib.sha256(token.encode()).hexdigest()
        now = self._clock.time()
        with self._lock:
            if self._ok.get(key, 0.0) > now:
                return True
        try:
            user = self._review(token, self._audience)
        except Exception:  # noqa: BLE001
            logger.exception("token review failed")
            return False
        if user not in self._subjects:
            logger.warning("reserve refused", extra={"user": user})
            return False
        with self._lock:
            self._ok = {k: t for k, t in self._ok.items() if t > now}
            self._ok[key] = now + AUTH_CACHE_SECONDS
        return True


def make_server(
    port: int,
    is_leader: Callable[[], bool],
    auth: TokenAuth,
    reserve: Callable[[str, str], Result],
) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_a: object) -> None:  # the stdlib default writes to stderr
            pass

        def _send(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/healthz":
                self._send(200, {"ok": True})
            elif self.path == "/readyz":
                # The Service then routes only to the leader.
                self._send(200 if is_leader() else 503, {"leader": is_leader()})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/reserve":
                self._send(404, {"error": "not found"})
                return
            if not auth.allowed(self.headers.get("Authorization")):
                self._send(401, {"error": "unauthorized"})
                return
            if not is_leader():
                self._send(503, {"error": "not the leader"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                req = json.loads(self.rfile.read(length) or b"{}")
                sandbox, tag = str(req["sandbox"]), str(req.get("tag", ""))
            except (ValueError, KeyError, TypeError):
                self._send(400, {"error": "want {sandbox, tag}"})
                return
            try:
                r = reserve(sandbox, tag)
            except Exception:  # noqa: BLE001
                logger.exception("reserve failed", extra={"sandbox": sandbox})
                self._send(500, {"error": "reserve failed"})
                return
            self._send(200, {"pv": r.pv, "pool": r.pool, "reason": r.reason})

    return ThreadingHTTPServer(("0.0.0.0", port), Handler)
