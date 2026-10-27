"""ServiceAccount token auth; mirrors services/conversation-router/svcauth and @scooter/svcauth."""

from __future__ import annotations

import hashlib
import os
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx

USER_HEADER = "x-scooter-user"
EMAIL_HEADER = "x-scooter-user-email"

REVIEW_TIMEOUT_S = 5.0
CACHE_TTL_S = 60.0
_CACHE_MAX = 4096

_SA_DIR = Path("/var/run/secrets/kubernetes.io/serviceaccount")


@dataclass(frozen=True)
class Review:
    ok: bool
    username: str = ""


ReviewFunc = Callable[[str], Awaitable[Review]]


def in_cluster_reviewer(audience: str, sa_dir: Path = _SA_DIR) -> ReviewFunc:
    """TokenReview against the in-cluster apiserver, pinned to `audience` ("" = apiserver default)."""

    async def review(token: str) -> Review:
        host = os.environ.get("KUBERNETES_SERVICE_HOST")
        port = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
        if not host:
            raise RuntimeError("tokenreview: not running in a cluster")
        if ":" in host:
            host = f"[{host}]"
        own = (sa_dir / "token").read_text().strip()
        spec: dict[str, object] = {"token": token}
        if audience:
            spec["audiences"] = [audience]
        async with httpx.AsyncClient(verify=str(sa_dir / "ca.crt"), timeout=REVIEW_TIMEOUT_S) as c:
            resp = await c.post(
                f"https://{host}:{port}/apis/authentication.k8s.io/v1/tokenreviews",
                headers={"authorization": f"Bearer {own}"},
                json={"apiVersion": "authentication.k8s.io/v1", "kind": "TokenReview", "spec": spec},
            )
        # 403 means missing RBAC, not a spoof.
        if resp.status_code >= 300:
            raise RuntimeError(f"tokenreview returned {resp.status_code}: {resp.text.strip()}")
        status = resp.json().get("status") or {}
        return Review(ok=status.get("authenticated") is True, username=(status.get("user") or {}).get("username", ""))

    return review


Kind = Literal["service", "sandbox"]


@dataclass(frozen=True)
class Principal:
    """user/email are set only when an asserter vouched."""

    kind: Kind
    service_account: str
    sandbox_id: str = ""
    user: str = ""
    email: str = ""


@dataclass(frozen=True)
class Policy:
    services: frozenset[str] = frozenset()
    # May set X-Scooter-User; admitted as services too.
    asserters: frozenset[str] = frozenset()
    # Admits `sandbox-<id>` SAs here; empty admits none.
    sandbox_namespace: str = ""


AuthErrorCode = Literal["no-token", "unauthenticated", "not-allowed", "review-failed"]

_STATUS: dict[str, int] = {"no-token": 401, "unauthenticated": 401, "not-allowed": 403, "review-failed": 503}


class AuthError(Exception):
    def __init__(self, code: AuthErrorCode, message: str, service_account: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.service_account = service_account

    @property
    def status(self) -> int:
        return _STATUS[self.code]


class Verifier:
    """Caches verdicts, never errors, so blips don't pin rejections."""

    def __init__(self, review: ReviewFunc, now: Callable[[], float] = time.monotonic) -> None:
        self._review = review
        self.now = now
        self._cache: dict[str, tuple[Review, float]] = {}

    async def verify(self, token: str) -> Review:
        key = hashlib.sha256(token.encode()).hexdigest()
        now = self.now()
        hit = self._cache.get(key)
        if hit and now < hit[1]:
            return hit[0]
        verdict = await self._review(token)
        if len(self._cache) >= _CACHE_MAX:
            self._cache = {k: v for k, v in self._cache.items() if now < v[1]}
            if len(self._cache) >= _CACHE_MAX:
                self._cache.clear()
        self._cache[key] = (verdict, now + CACHE_TTL_S)
        return verdict

    async def resolve(self, headers: Mapping[str, str], policy: Policy) -> Principal:
        """Ignores identity headers from non-asserters; forwarders must strip."""
        token = bearer_token(headers)
        if not token:
            raise AuthError("no-token", "bearer token required")
        try:
            verdict = await self.verify(token)
        except Exception as exc:
            raise AuthError("review-failed", f"token review: {exc}") from exc
        if not verdict.ok or not verdict.username:
            raise AuthError("unauthenticated", "token not authenticated")
        sa = verdict.username
        if sa in policy.asserters:
            return Principal(
                kind="service", service_account=sa,
                user=_header(headers, USER_HEADER), email=_header(headers, EMAIL_HEADER),
            )
        if sa in policy.services:
            return Principal(kind="service", service_account=sa)
        sid = sandbox_id(sa, policy.sandbox_namespace)
        if sid:
            return Principal(kind="sandbox", service_account=sa, sandbox_id=sid)
        raise AuthError("not-allowed", f"caller not allowed: {sa}", sa)


def _header(headers: Mapping[str, str], name: str) -> str:
    return (headers.get(name) or "").strip()


def bearer_token(headers: Mapping[str, str]) -> str:
    """The `Authorization: Bearer` value, or ""."""
    v = _header(headers, "authorization")
    if not v.lower().startswith("bearer "):
        return ""
    return v[len("bearer "):].strip()


_SANDBOX_SA = re.compile(r"^sandbox-([a-z0-9][a-z0-9-]*)$")


def sandbox_id(username: str, namespace: str) -> str:
    """Extracts `<id>` from `sandbox-<id>`, only within namespace; "" otherwise."""
    if not namespace:
        return ""
    prefix = f"system:serviceaccount:{namespace}:"
    if not username.startswith(prefix):
        return ""
    m = _SANDBOX_SA.match(username[len(prefix):])
    return m.group(1) if m else ""


def parse_allowlist(csv: str | None) -> frozenset[str]:
    return frozenset(s.strip() for s in (csv or "").split(",") if s.strip())


class TokenSource:
    """Re-reads the token file; the kubelet rotates it."""

    def __init__(self, path: str | Path, refresh_s: float = 60.0, now: Callable[[], float] = time.monotonic) -> None:
        self.path = Path(path)
        self.refresh_s = refresh_s
        self.now = now
        self._token = ""
        self._read = 0.0

    def current(self) -> str:
        """"" when no token is mounted."""
        now = self.now()
        if self._token and now - self._read < self.refresh_s:
            return self._token
        try:
            self._token = self.path.read_text().strip()
        except FileNotFoundError:
            return ""
        self._read = now
        return self._token

    def headers(self, user: str = "", email: str = "") -> dict[str, str]:
        """Bearer token plus, if set, user headers."""
        out: dict[str, str] = {}
        token = self.current()
        if token:
            out["Authorization"] = f"Bearer {token}"
        if user:
            out[USER_HEADER] = user
            if email:
                out[EMAIL_HEADER] = email
        return out
