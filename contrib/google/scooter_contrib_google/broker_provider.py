"""Google provider: service-account tokens over an http-proxy to a fixed set of Google API hosts.

Proxies /google/<host>/<path> to https://<host>.googleapis.com/<path>; any host
outside ALLOWED_HOSTS is a 404, so the broker is never an open proxy carrying a
Google token. Enabled iff a valid service-account key is configured.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from fastapi import APIRouter, HTTPException

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import AuthDependency, Credential, Identity, Provider, Transport

from .config import GoogleSettings
from .service_account import GoogleServiceAccountSource, SubjectNotAllowed

logger = logging.getLogger(__name__)

# Subdomains of googleapis.com: www serves Drive, Calendar and uploads; the rest serve their own API.
ALLOWED_HOSTS = ("www", "drive", "docs", "sheets", "slides", "gmail", "people", "tasks", "forms")


@dataclass
class _ForbiddenAsHttp:
    """Wraps a credential source so a disallowed subject is a 403, not a 500."""

    inner: GoogleServiceAccountSource

    async def get(self, identity: Identity) -> Credential:
        try:
            return await self.inner.get(identity)
        except SubjectNotAllowed as e:
            raise HTTPException(status_code=403, detail=str(e)) from e


@dataclass
class GoogleApiProxy(Transport):
    hosts: tuple[str, ...] = ALLOWED_HOSTS
    name: str = "http-proxy"
    proxies: dict[str, HttpProxy] = field(init=False)

    def __post_init__(self) -> None:
        self.proxies = {h: HttpProxy(upstream=f"https://{h}.googleapis.com") for h in self.hosts}

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()
        for host, proxy in self.proxies.items():
            router.include_router(proxy.routes(provider, authed), prefix=f"/{host}")
        return router


def _load_key(raw: str) -> dict | None:
    if not raw.strip():
        return None
    try:
        info = json.loads(raw)
    except json.JSONDecodeError:
        logger.error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON; google provider disabled")
        return None
    if not isinstance(info, dict) or not info.get("client_email") or not info.get("private_key"):
        logger.error("GOOGLE_SERVICE_ACCOUNT_JSON lacks client_email/private_key; google provider disabled")
        return None
    return info


@register_provider
def google() -> Provider:
    # Read at build time, once per create_app().
    settings = GoogleSettings()
    info = _load_key(settings.google_service_account_json)
    source = GoogleServiceAccountSource(
        info=info or {},
        scopes=settings.scopes,
        subject=settings.google_subject.strip(),
        impersonate_owner=settings.google_impersonate_owner,
        owner_domains=settings.owner_domains,
    )
    if settings.google_impersonate_owner and not source.owner_domains:
        logger.error("GOOGLE_IMPERSONATE_OWNER needs GOOGLE_OWNER_DOMAINS; google provider disabled")
        info = None
    return Provider(
        name="google",
        credential=_ForbiddenAsHttp(source),
        transports=[GoogleApiProxy()],
        enabled=info is not None,
    )
