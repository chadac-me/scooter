"""GitHub App credential source: a short-lived RS256 App JWT exchanged for an installation access token, cached per installation; with `owners`, each request uses the installation on the account it names, and no other account's installation is ever used."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import httpx
import jwt

from scooter_broker_lib.types import Credential, CredentialSource, Identity

if TYPE_CHECKING:
    from scooter_broker_lib.forge import ForgeRequest

logger = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"
_TOKEN_TTL = 50 * 60  # tokens last 1h
# A miss re-lists installations at most this often.
_LIST_INTERVAL = 60
# Conversations whose last owner is remembered.
_AFFINITY_MAX = 4096


def request_owner(request: "ForgeRequest | None") -> str | None:
    """The account a forge request names, lowercased, or None."""
    if request is None:
        return None
    if request.repo and "/" in request.repo:
        return request.repo.split("/", 1)[0].lower()
    # gh's repo-scoped GraphQL queries pass `owner` as a variable.
    for variables in _graphql_variables(request.graphql_body):
        owner = variables.get("owner")
        if isinstance(owner, str) and owner:
            return owner.lower()
    return None


def _graphql_variables(body: bytes | None) -> list[dict]:
    """Each operation's `variables` object in a GraphQL body."""
    try:
        payload = json.loads(body or b"null")
    except ValueError:
        return []
    batch = payload if isinstance(payload, list) else [payload]
    return [v for item in batch if isinstance(item, dict) and isinstance(v := item.get("variables"), dict)]


@dataclass
class GitHubAppSource(CredentialSource):
    app_id: str
    private_key: str                   # PEM content or path
    # Fallback installation; 0 means the first owner's.
    installation_id: int = 0
    # Accounts whose installations may be used; empty: installation_id only.
    owners: tuple[str, ...] = ()
    api_base: str = GITHUB_API

    # installation id -> (token, expires_at)
    _tokens: dict[int, tuple[str, float]] = field(default_factory=dict, repr=False)
    # lowercased owner -> installation id, allowed owners only
    _installations: dict[str, int] = field(default_factory=dict, repr=False)
    _listed_at: float = field(default=0.0, repr=False)
    _list_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    # conversation id -> last allowed owner it named
    _affinity: OrderedDict[str, str] = field(default_factory=OrderedDict, repr=False)

    def __post_init__(self) -> None:
        self.owners = tuple(o.strip().lower() for o in self.owners if o.strip())

    def _load_private_key(self) -> str:
        key = self.private_key
        if not key.startswith("-----") and "/" in key:
            with open(key) as f:
                return f.read()
        return key

    def _generate_jwt(self) -> str:
        now = int(time.time())
        # GitHub caps exp at 10 minutes; 9 tolerates a fast clock.
        payload = {"iat": now - 60, "exp": now + 9 * 60, "iss": self.app_id}
        return jwt.encode(payload, self._load_private_key(), algorithm="RS256")

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._generate_jwt()}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    async def get(self, identity: Identity, request: "ForgeRequest | None" = None) -> Credential:
        installation_id = await self._choose_installation(identity, request)
        cached = self._tokens.get(installation_id)
        if cached and time.time() < cached[1]:
            return Credential(kind="bearer", value=cached[0], expires_at=cached[1])

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{self.api_base}/app/installations/{installation_id}/access_tokens",
                headers=self._headers(),
            )
            if resp.status_code == 404:
                # Reinstalling changes the id; re-list on the next call.
                self._forget(installation_id)
            resp.raise_for_status()
            token = resp.json()["token"]

        expires_at = time.time() + _TOKEN_TTL
        self._tokens[installation_id] = (token, expires_at)
        return Credential(kind="bearer", value=token, expires_at=expires_at)

    async def _choose_installation(self, identity: Identity, request: "ForgeRequest | None") -> int:
        if not self.owners:
            return self.installation_id

        owner = request_owner(request)
        if owner in self.owners:
            self._remember(identity.conversation_id, owner)
        else:
            # Owner-less calls follow the conversation's last owner.
            owner = self._affinity.get(identity.conversation_id)
        if owner:
            installation_id = await self._installation_for(owner)
            if installation_id:
                return installation_id
            logger.warning("App not installed on owner; using the default", extra={"owner": owner})
        return await self._default_installation()

    async def _default_installation(self) -> int:
        if self.installation_id:
            return self.installation_id
        for owner in self.owners:
            if installation_id := await self._installation_for(owner):
                return installation_id
        raise RuntimeError(f"the GitHub App is installed on none of {', '.join(self.owners)}")

    def _forget(self, installation_id: int) -> None:
        self._installations = {o: i for o, i in self._installations.items() if i != installation_id}
        self._listed_at = 0.0

    def _remember(self, conversation_id: str, owner: str) -> None:
        if not conversation_id:
            return
        self._affinity[conversation_id] = owner
        self._affinity.move_to_end(conversation_id)
        while len(self._affinity) > _AFFINITY_MAX:
            self._affinity.popitem(last=False)

    async def _installation_for(self, owner: str) -> int | None:
        if owner in self._installations:
            return self._installations[owner]
        async with self._list_lock:
            if owner not in self._installations and time.time() - self._listed_at >= _LIST_INTERVAL:
                self._installations = await self._list_installations()
                self._listed_at = time.time()
        return self._installations.get(owner)

    async def _list_installations(self) -> dict[str, int]:
        """The App's installations on allowed owners, by lowercased account login."""
        found: dict[str, int] = {}
        url: str | None = f"{self.api_base}/app/installations?per_page=100"
        async with httpx.AsyncClient(timeout=15) as client:
            while url:
                resp = await client.get(url, headers=self._headers())
                resp.raise_for_status()
                for inst in resp.json():
                    login = ((inst.get("account") or {}).get("login") or "").lower()
                    if login in self.owners:
                        found[login] = int(inst["id"])
                url = resp.links.get("next", {}).get("url")
        return found
