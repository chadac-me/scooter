"""Each user's SSH key, in this contrib's own `contrib_ssh` database.

The DDL lives in contrib/ssh/sql/schema.sql (Atlas owns it); this module never
creates tables. The private seed is stored sealed, bound to the user it belongs to.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import String, Text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.store import StoreConfig, open_sessions
from scooter_broker_lib.user_secrets import SecretBox, UserGrant

from .keys import KeyPair, fingerprint


class _Base(DeclarativeBase):
    pass


class _Key(_Base):
    __tablename__ = "ssh_keys"

    user_id: Mapped[str] = mapped_column(String, primary_key=True)
    public_key: Mapped[str] = mapped_column(Text)
    fingerprint: Mapped[str] = mapped_column(String)
    private_key: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String)


@dataclass(frozen=True)
class UserKey:
    user_id: str
    pair: KeyPair
    public_key: str
    fingerprint: str
    created_at: str

    def payload(self) -> dict:
        return {"public_key": self.public_key, "fingerprint": self.fingerprint, "created_at": self.created_at}


def comment_for(user_id: str) -> str:
    # The user id is an email or a login, either fine in a key comment.
    return f"{user_id} (scooter)"


_PURPOSE = "ssh:key"


class SshKeyStore:
    def __init__(self, config: StoreConfig, box: SecretBox) -> None:
        self._engine, self._session = open_sessions(config)
        self._box = box

    async def _load(self, grant: UserGrant, row: _Key) -> UserKey:
        seed = base64.b64decode(await self._box.open(grant, _PURPOSE, row.private_key))
        return UserKey(row.user_id, KeyPair(seed), row.public_key, row.fingerprint, row.created_at)

    async def _row(self, grant: UserGrant, pair: KeyPair) -> _Key:
        return _Key(
            user_id=grant.user,
            public_key=pair.authorized_key(comment_for(grant.user)),
            fingerprint=fingerprint(pair.blob),
            private_key=await self._box.seal(grant, _PURPOSE, base64.b64encode(pair.seed).decode()),
            created_at=datetime.now(timezone.utc).isoformat(),
        )

    async def get(self, grant: UserGrant) -> UserKey | None:
        async with self._session() as s:
            row = await s.get(_Key, grant.user)
        return await self._load(grant, row) if row else None

    async def get_or_create(self, grant: UserGrant) -> tuple[UserKey, bool]:
        """The user's key and whether this call created it."""
        existing = await self.get(grant)
        if existing is not None:
            return existing, False
        row = await self._row(grant, KeyPair.generate())
        try:
            async with self._session() as s, s.begin():
                s.add(row)
        except IntegrityError:
            # A concurrent first visit created it: keep theirs.
            found = await self.get(grant)
            assert found is not None
            return found, False
        return await self._load(grant, row), True

    async def rotate(self, grant: UserGrant) -> tuple[UserKey | None, UserKey]:
        """Replace the user's key with a fresh one; returns (old, new)."""
        old = await self.get(grant)
        fresh = await self._row(grant, KeyPair.generate())
        async with self._session() as s, s.begin():
            await s.merge(fresh)
        return old, await self._load(grant, fresh)

