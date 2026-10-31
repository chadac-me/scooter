"""Encryption at rest for the per-user secrets a contrib stores: tokens, private keys.

Each value is sealed with AES-256-GCM under the keyring's current key and bound to a
purpose and a user, so a ciphertext copied into another user's row fails to open. A
sealed value names its key, so old rows stay readable after a new key becomes current.

`SecretBox` seals and opens only with a `UserGrant`, and the user it binds to is the
grant's. Exactly two places mint one: `OwnerResolver.grant`, for the owner of a private
conversation, and `user.user_grant`, for the user's own Settings session. So code
holding the box still cannot open a secret outside those two situations, and
`scripts/check-user-grants.sh` fails CI if any other module calls `_mint`.

The broker supplies the keyring (from a Secret only it reads) through
``BrokerContext.user_secrets``; a contrib never builds one itself.
"""

from __future__ import annotations

import asyncio
import base64
import os
import re
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_VERSION = "v1"
_KEY_ID = re.compile(r"^[a-z0-9]{1,32}$")
_NONCE_BYTES = 12


class SecretError(Exception):
    """A sealed value could not be opened: unknown key, tampering, or the wrong context."""


@dataclass(frozen=True)
class KeyRing:
    """Named 256-bit keys and the one that seals new values."""

    keys: dict[str, bytes]
    current: str

    def __post_init__(self) -> None:
        if self.current not in self.keys:
            raise ValueError(f"current key {self.current!r} is not in the keyring")
        for kid, key in self.keys.items():
            if not _KEY_ID.match(kid):
                raise ValueError(f"key id {kid!r} must match {_KEY_ID.pattern}")
            if len(key) != 32:
                raise ValueError(f"key {kid!r} must be 32 bytes")

    @staticmethod
    def generate(kid: str = "k1") -> "KeyRing":
        return KeyRing(keys={kid: os.urandom(32)}, current=kid)


_MINTED = object()


@dataclass(frozen=True)
class UserGrant:
    """Proof that the caller may use `user`'s secrets; built only by `_mint`."""

    user: str
    # Why access was granted: "private-conversation" or "settings-session".
    via: str
    _token: object = field(default=None, repr=False, compare=False)

    def __post_init__(self) -> None:
        if self._token is not _MINTED:
            raise TypeError("a UserGrant comes only from OwnerResolver.grant or user.user_grant")
        if not self.user:
            raise ValueError("a UserGrant needs a user")


def _mint(user: str, via: str) -> UserGrant:
    """A grant for `user`; scripts/check-user-grants.sh limits who may call this."""
    return UserGrant(user, via, _MINTED)


def _aad(grant: UserGrant, purpose: str) -> str:
    if not purpose or "\0" in purpose:
        raise ValueError(f"invalid purpose {purpose!r}")
    return f"{purpose}\0{grant.user}"


def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def seal(ring: KeyRing, plaintext: str, context: str) -> str:
    """`plaintext` encrypted under the current key, as ``v1.<key id>.<nonce+ciphertext>``."""
    nonce = os.urandom(_NONCE_BYTES)
    ct = AESGCM(ring.keys[ring.current]).encrypt(nonce, plaintext.encode(), context.encode())
    return f"{_VERSION}.{ring.current}.{_b64e(nonce + ct)}"


def open_sealed(ring: KeyRing, sealed: str, context: str) -> str:
    """The plaintext of a `seal` result made with the same `context`, or SecretError."""
    try:
        version, kid, body = sealed.split(".", 2)
    except ValueError:
        raise SecretError("not a sealed value") from None
    if version != _VERSION:
        raise SecretError(f"unsupported sealed-value version {version!r}")
    key = ring.keys.get(kid)
    if key is None:
        raise SecretError(f"sealed with unknown key {kid!r}")
    try:
        raw = _b64d(body)
        return AESGCM(key).decrypt(raw[:_NONCE_BYTES], raw[_NONCE_BYTES:], context.encode()).decode()
    except (InvalidTag, ValueError) as e:
        raise SecretError("sealed value failed authentication") from e


class SecretBox:
    """Seals and opens one user's secrets under a `UserGrant`, loading the keyring once on first use."""

    def __init__(self, load: Callable[[], Awaitable[KeyRing]]):
        self._load = load
        self._cached: KeyRing | None = None
        self._lock = asyncio.Lock()

    @staticmethod
    def of(ring: KeyRing) -> "SecretBox":
        """A box over a fixed keyring, for tests and local runs."""

        async def load() -> KeyRing:
            return ring

        return SecretBox(load)

    async def _ring(self) -> KeyRing:
        if self._cached is None:
            async with self._lock:
                if self._cached is None:
                    self._cached = await self._load()
        return self._cached

    async def seal(self, grant: UserGrant, purpose: str, plaintext: str) -> str:
        """`plaintext` sealed to `grant.user` for `purpose`, e.g. ``"github:access"``."""
        return seal(await self._ring(), plaintext, _aad(grant, purpose))

    async def open(self, grant: UserGrant, purpose: str, sealed: str) -> str:
        """A value sealed to `grant.user` for `purpose`; SecretError for anyone else's."""
        return open_sealed(await self._ring(), sealed, _aad(grant, purpose))
