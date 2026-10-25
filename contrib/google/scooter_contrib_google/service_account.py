"""Service-account credential source: a signed JWT exchanged for a short-lived access token, cached per impersonated user."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

import httpx
import jwt

from scooter_broker_lib.types import Credential, CredentialSource, Identity

DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer"
# Google caps an assertion at one hour.
ASSERTION_TTL = 3600


class SubjectNotAllowed(PermissionError):
    """The caller has no Google user this deployment may act as."""


@dataclass
class GoogleServiceAccountSource(CredentialSource):
    info: dict
    scopes: list[str]
    subject: str = ""
    impersonate_owner: bool = False
    owner_domains: set[str] = field(default_factory=set)

    _cache: dict[str, tuple[str, float]] = field(default_factory=dict, repr=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    def subject_for(self, identity: Identity) -> str:
        """The user to impersonate for this caller ("" means the service account itself)."""
        if not self.impersonate_owner:
            return self.subject
        owner = (identity.owner or "").strip().lower()
        domain = owner.rpartition("@")[2]
        if "@" in owner and domain in self.owner_domains:
            return owner
        # Never fall back to the static subject: that would hand one user's mail to another.
        raise SubjectNotAllowed(f"conversation owner {owner or '<none>'} is not in an allowed Google domain")

    def assertion(self, subject: str, now: int) -> str:
        token_uri = self.info.get("token_uri") or DEFAULT_TOKEN_URI
        claims = {
            "iss": self.info["client_email"],
            "scope": " ".join(self.scopes),
            "aud": token_uri,
            "iat": now,
            "exp": now + ASSERTION_TTL,
        }
        if subject:
            claims["sub"] = subject
        headers = {"kid": self.info["private_key_id"]} if self.info.get("private_key_id") else None
        return jwt.encode(claims, self.info["private_key"], algorithm="RS256", headers=headers)

    async def get(self, identity: Identity) -> Credential:
        subject = self.subject_for(identity)
        async with self._lock:
            cached = self._cache.get(subject)
            if cached and time.time() < cached[1] - 60:
                return Credential(kind="bearer", value=cached[0], expires_at=cached[1])

            now = int(time.time())
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    self.info.get("token_uri") or DEFAULT_TOKEN_URI,
                    data={"grant_type": JWT_BEARER, "assertion": self.assertion(subject, now)},
                )
                resp.raise_for_status()
                data = resp.json()

            token = data["access_token"]
            expires_at = now + int(data.get("expires_in", ASSERTION_TTL))
            self._cache[subject] = (token, expires_at)
            return Credential(kind="bearer", value=token, expires_at=expires_at)
