"""Profile and note store, in this contrib's own `contrib_personalization` database.

The DDL lives in contrib/personalization/sql/schema.sql (Atlas owns it); this module never creates
tables. Categories are an open set of strings, so a new one needs no migration.
"""

from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import Boolean, String, Text, delete, select
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.store import StoreConfig, open_sessions

# The categories the prompt and the tab know about; any other string is also accepted.
KNOWN_CATEGORIES = ("common-asks", "agent-habits", "preferences", "environment")
SOURCES = ("agent", "user")


class _Base(DeclarativeBase):
    pass


class _Profile(_Base):
    __tablename__ = "personalization_profiles"

    owner: Mapped[str] = mapped_column(String, primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # ISO-8601 strings, like the other broker tables.
    last_analyzed_at: Mapped[str | None] = mapped_column(String, nullable=True)
    last_conversation_seen: Mapped[str | None] = mapped_column(String, nullable=True)
    refresh_requested_at: Mapped[str | None] = mapped_column(String, nullable=True)
    last_run_conversation: Mapped[str | None] = mapped_column(String, nullable=True)


class _Note(_Base):
    __tablename__ = "personalization_notes"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    owner: Mapped[str] = mapped_column(String, index=True)
    category: Mapped[str] = mapped_column(String, index=True)
    note: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str] = mapped_column(String)
    updated_at: Mapped[str] = mapped_column(String)


@dataclass
class Profile:
    owner: str
    # Opt-out: a user with no row is enabled.
    enabled: bool = True
    last_analyzed_at: str | None = None
    last_conversation_seen: str | None = None
    refresh_requested_at: str | None = None
    last_run_conversation: str | None = None

    def payload(self) -> dict:
        return asdict(self)


@dataclass
class Note:
    id: str
    owner: str
    category: str
    note: str
    source: str
    pinned: bool
    created_at: str
    updated_at: str

    def payload(self) -> dict:
        d = asdict(self)
        del d["owner"]
        return d


def _profile(row: _Profile) -> Profile:
    return Profile(
        owner=row.owner,
        enabled=row.enabled,
        last_analyzed_at=row.last_analyzed_at,
        last_conversation_seen=row.last_conversation_seen,
        refresh_requested_at=row.refresh_requested_at,
        last_run_conversation=row.last_run_conversation,
    )


def _note(row: _Note) -> Note:
    return Note(
        id=row.id, owner=row.owner, category=row.category, note=row.note,
        source=row.source, pinned=row.pinned, created_at=row.created_at,
        updated_at=row.updated_at,
    )


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class ProtectedNote(Exception):
    """An agent write tried to change a user-sourced or pinned note."""


class PersonalizationStore:
    def __init__(self, config: StoreConfig) -> None:
        self._engine: AsyncEngine
        self._engine, self._session = open_sessions(config)

    # -- profiles -----------------------------------------------------------

    async def profile(self, owner: str) -> Profile:
        async with self._session() as s:
            row = await s.get(_Profile, owner)
            return _profile(row) if row else Profile(owner=owner)

    async def update_profile(self, owner: str, **fields) -> Profile:
        async with self._session() as s, s.begin():
            row = await s.get(_Profile, owner)
            if row is None:
                row = _Profile(owner=owner, enabled=True)
                s.add(row)
            for k, v in fields.items():
                setattr(row, k, v)
            await s.flush()
            return _profile(row)

    async def eligible(
        self, *, interval: timedelta, limit: int, latest_activity: dict[str, str], now: datetime
    ) -> list[str]:
        """Owners due for a refresh, requested ones first, then oldest analysis.

        `latest_activity` maps owner -> their newest non-system conversation's
        timestamp; the caller gets it from the agent-host, which owns conversations.
        Owners with no profile row count as enabled and never analysed (opt-out).
        """
        async with self._session() as s:
            rows = {r.owner: r for r in (await s.execute(select(_Profile))).scalars()}
        cutoff = (now - interval).isoformat()
        requested: list[tuple[str, str]] = []
        due: list[tuple[str, str]] = []
        for owner in set(rows) | set(latest_activity):
            row = rows.get(owner)
            if row is not None and not row.enabled:
                continue
            if row is not None and row.refresh_requested_at:
                requested.append((row.refresh_requested_at, owner))
                continue
            last = row.last_analyzed_at if row else None
            if last is not None and last > cutoff:
                continue
            seen = row.last_conversation_seen if row else None
            newest = latest_activity.get(owner)
            if newest is None or (seen is not None and newest <= seen):
                continue
            due.append((last or "", owner))
        ordered = [o for _, o in sorted(requested)] + [o for _, o in sorted(due)]
        return ordered[:limit]

    # -- notes --------------------------------------------------------------

    async def notes(self, owner: str, category: str | None = None) -> list[Note]:
        async with self._session() as s:
            stmt = select(_Note).where(_Note.owner == owner)
            if category:
                stmt = stmt.where(_Note.category == category)
            stmt = stmt.order_by(_Note.category, _Note.created_at)
            return [_note(r) for r in (await s.execute(stmt)).scalars()]

    async def add_note(
        self, owner: str, *, category: str, note: str, source: str, pinned: bool = False
    ) -> Note:
        now = now_iso()
        row = _Note(
            id=uuid.uuid4().hex[:12], owner=owner, category=category, note=note,
            source=source, pinned=pinned, created_at=now, updated_at=now,
        )
        async with self._session() as s, s.begin():
            s.add(row)
        return _note(row)

    async def update_note(
        self, owner: str, note_id: str, *, as_agent: bool, **fields
    ) -> Note | None:
        """Update a note; None if it is not this owner's.

        A user edit turns an agent note into a user note, so the next run leaves it
        alone. An agent edit of a user or pinned note raises ProtectedNote.
        """
        async with self._session() as s, s.begin():
            row = await s.get(_Note, note_id)
            if row is None or row.owner != owner:
                return None
            if as_agent and (row.source == "user" or row.pinned):
                raise ProtectedNote(note_id)
            for k, v in fields.items():
                setattr(row, k, v)
            if not as_agent and "note" in fields:
                row.source = "user"
            row.updated_at = now_iso()
            await s.flush()
            return _note(row)

    async def delete_note(self, owner: str, note_id: str, *, as_agent: bool) -> bool:
        async with self._session() as s, s.begin():
            row = await s.get(_Note, note_id)
            if row is None or row.owner != owner:
                return False
            if as_agent and (row.source == "user" or row.pinned):
                raise ProtectedNote(note_id)
            await s.delete(row)
            return True

    async def delete_all_notes(self, owner: str) -> int:
        async with self._session() as s, s.begin():
            result = await s.execute(delete(_Note).where(_Note.owner == owner))
            return result.rowcount or 0
