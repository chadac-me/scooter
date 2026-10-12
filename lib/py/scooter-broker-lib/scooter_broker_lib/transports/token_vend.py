"""token-vend transport: returns a short-lived raw token to an authorized caller at `/{provider}/token`, exposing the token unlike http-proxy."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter

from ..types import AuthDependency, Provider, Transport


@dataclass
class TokenVend(Transport):
    name: str = "token-vend"

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        """Mount GET /token, returning {token, expires_at} for the authenticated caller."""
        ...
