"""Bundle and search-index store, in this contrib's own `contrib_handoff` database.

The DDL lives in contrib/handoff/sql/schema.sql (Atlas owns it); this module never creates
tables. Search uses Postgres full-text search, with a LIKE fallback for the SQLite tests.
"""

from __future__ import annotations

import re
import secrets
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import BigInteger, Integer, LargeBinary, String, Text, delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.store import StoreConfig, open_sessions

UPLOADING, READY = "uploading", "ready"
# An upload unfinished this long is abandoned.
_STALE_UPLOAD = timedelta(hours=6)
_SNIPPET_CHARS = 240
# Candidate messages read per query, before grouping by conversation.
_CANDIDATES = 200


class _Base(DeclarativeBase):
    pass


class _Bundle(_Base):
    __tablename__ = "handoff_bundles"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    # The uploading sandbox's key: a sandbox call's only identity.
    uploader: Mapped[str] = mapped_column(String, index=True)
    state: Mapped[str] = mapped_column(String)
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str | None] = mapped_column(String, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # ISO-8601 strings, like the other broker tables.
    created_at: Mapped[str] = mapped_column(String)
    expires_at: Mapped[str] = mapped_column(String, index=True)


class _Chunk(_Base):
    __tablename__ = "handoff_bundle_chunks"

    bundle_id: Mapped[str] = mapped_column(String, primary_key=True)
    seq: Mapped[int] = mapped_column(Integer, primary_key=True)
    data: Mapped[bytes] = mapped_column(LargeBinary)


class _Conversation(_Base):
    __tablename__ = "handoff_conversations"

    conversation_id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str] = mapped_column(Text)
    owner: Mapped[str | None] = mapped_column(String, nullable=True)
    last_activity_at: Mapped[int] = mapped_column(BigInteger)


class _Message(_Base):
    __tablename__ = "handoff_messages"

    conversation_id: Mapped[str] = mapped_column(String, primary_key=True)
    seq: Mapped[int] = mapped_column(Integer, primary_key=True)
    role: Mapped[str] = mapped_column(String)
    text: Mapped[str] = mapped_column(Text)


@dataclass(frozen=True)
class Bundle:
    id: str
    uploader: str
    size_bytes: int
    sha256: str | None
    description: str | None
    created_at: str
    expires_at: str

    def payload(self) -> dict:
        return {
            "id": self.id, "bytes": self.size_bytes, "sha256": self.sha256,
            "description": self.description, "created_at": self.created_at, "expires_at": self.expires_at,
        }


@dataclass(frozen=True)
class Hit:
    conversation_id: str
    title: str
    owner: str | None
    last_activity_at: int
    snippet: str
    score: float


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _bundle(row: _Bundle) -> Bundle:
    return Bundle(
        id=row.id, uploader=row.uploader, size_bytes=row.size_bytes, sha256=row.sha256,
        description=row.description, created_at=row.created_at, expires_at=row.expires_at,
    )


class HandoffStore:
    def __init__(self, config: StoreConfig, *, ttl: timedelta) -> None:
        self._engine: AsyncEngine
        self._engine, self._session = open_sessions(config)
        self.ttl = ttl

    # -- bundles ------------------------------------------------------------

    async def begin_bundle(self, uploader: str, description: str | None, now: datetime) -> str:
        bundle_id = "b_" + secrets.token_urlsafe(18)
        async with self._session() as s, s.begin():
            s.add(_Bundle(
                id=bundle_id, uploader=uploader, state=UPLOADING, size_bytes=0, description=description,
                created_at=now.isoformat(), expires_at=(now + self.ttl).isoformat(),
            ))
        return bundle_id

    async def add_chunk(self, bundle_id: str, seq: int, data: bytes) -> None:
        async with self._session() as s, s.begin():
            s.add(_Chunk(bundle_id=bundle_id, seq=seq, data=data))

    async def finish_bundle(self, bundle_id: str, *, size: int, sha256: str) -> Bundle:
        async with self._session() as s, s.begin():
            row = await s.get(_Bundle, bundle_id)
            row.state, row.size_bytes, row.sha256 = READY, size, sha256
            await s.flush()
            return _bundle(row)

    async def bundle(self, bundle_id: str, now: datetime) -> Bundle | None:
        """A ready, unexpired bundle."""
        async with self._session() as s:
            row = await s.get(_Bundle, bundle_id)
        if row is None or row.state != READY or row.expires_at <= now.isoformat():
            return None
        return _bundle(row)

    async def touch_bundle(self, bundle_id: str, now: datetime) -> None:
        async with self._session() as s, s.begin():
            await s.execute(
                update(_Bundle).where(_Bundle.id == bundle_id).values(expires_at=(now + self.ttl).isoformat())
            )

    async def chunks(self, bundle_id: str) -> AsyncIterator[bytes]:
        """The bundle's bytes, one chunk per query so memory stays one chunk deep."""
        async with self._session() as s:
            seqs = (await s.execute(
                select(_Chunk.seq).where(_Chunk.bundle_id == bundle_id).order_by(_Chunk.seq)
            )).scalars().all()
        for seq in seqs:
            async with self._session() as s:
                row = await s.get(_Chunk, (bundle_id, seq))
            if row is not None:
                yield row.data

    async def usage(self, uploader: str, now: datetime) -> int:
        """Bytes the uploader holds in live bundles, counting unfinished uploads by their chunks."""
        async with self._session() as s:
            ready = await s.scalar(
                select(func.coalesce(func.sum(_Bundle.size_bytes), 0)).where(
                    _Bundle.uploader == uploader, _Bundle.state == READY, _Bundle.expires_at > now.isoformat()
                )
            )
            pending = await s.scalar(
                select(func.coalesce(func.sum(func.length(_Chunk.data)), 0))
                .join(_Bundle, _Bundle.id == _Chunk.bundle_id)
                .where(_Bundle.uploader == uploader, _Bundle.state == UPLOADING)
            )
        return int(ready or 0) + int(pending or 0)

    async def delete_bundle(self, bundle_id: str, uploader: str | None = None) -> bool:
        """Delete a bundle and its bytes; with `uploader`, only that uploader's."""
        async with self._session() as s, s.begin():
            row = await s.get(_Bundle, bundle_id)
            if row is None or (uploader is not None and row.uploader != uploader):
                return False
            await s.execute(delete(_Chunk).where(_Chunk.bundle_id == bundle_id))
            await s.delete(row)
        return True

    async def purge_bundles(self, now: datetime) -> int:
        """Delete expired bundles and abandoned uploads; returns how many."""
        stale = (now - _STALE_UPLOAD).isoformat()
        async with self._session() as s:
            ids = (await s.execute(
                select(_Bundle.id).where(
                    (_Bundle.expires_at <= now.isoformat())
                    | ((_Bundle.state == UPLOADING) & (_Bundle.created_at <= stale))
                )
            )).scalars().all()
        for bundle_id in ids:
            await self.delete_bundle(bundle_id)
        return len(ids)

    # -- search index -------------------------------------------------------

    async def indexed(self) -> dict[str, int]:
        """conversation id -> the activity time it was indexed at."""
        async with self._session() as s:
            rows = (await s.execute(select(_Conversation.conversation_id, _Conversation.last_activity_at))).all()
        return {cid: at for cid, at in rows}

    async def replace_conversation(
        self, conversation_id: str, *, title: str, owner: str | None, last_activity_at: int,
        messages: list[tuple[str, str]],
    ) -> None:
        """Swap in a conversation's current messages, as (role, text) in order."""
        async with self._session() as s, s.begin():
            await s.execute(delete(_Message).where(_Message.conversation_id == conversation_id))
            await s.merge(_Conversation(
                conversation_id=conversation_id, title=title, owner=owner, last_activity_at=last_activity_at,
            ))
            s.add_all(
                _Message(conversation_id=conversation_id, seq=i, role=role, text=body)
                for i, (role, body) in enumerate(messages)
            )

    async def remove_conversations(self, ids: list[str]) -> None:
        if not ids:
            return
        async with self._session() as s, s.begin():
            await s.execute(delete(_Message).where(_Message.conversation_id.in_(ids)))
            await s.execute(delete(_Conversation).where(_Conversation.conversation_id.in_(ids)))

    async def search(self, query: str, limit: int, *, exclude: set[str] = frozenset()) -> list[Hit]:
        """Best-matching conversations, one hit each, best first."""
        if self._engine.dialect.name == "postgresql":
            matches = await self._search_fts(query)
        else:
            matches = await self._search_like(query)
        best: dict[str, tuple[float, str]] = {}
        for cid, score, snippet in matches:
            if cid not in exclude and (cid not in best or score > best[cid][0]):
                best[cid] = (score, snippet)
        if not best:
            return []
        async with self._session() as s:
            convs = {
                c.conversation_id: c
                for c in (await s.execute(
                    select(_Conversation).where(_Conversation.conversation_id.in_(list(best)))
                )).scalars()
            }
        terms = _terms(query)
        hits = []
        for cid, (score, snippet) in best.items():
            conv = convs.get(cid)
            if conv is None:
                continue
            # A title match outranks a passing mention in one message.
            if terms and all(t in conv.title.lower() for t in terms):
                score += 1.0
            hits.append(Hit(cid, conv.title, conv.owner, conv.last_activity_at, snippet, round(score, 4)))
        hits.sort(key=lambda h: (h.score, h.last_activity_at), reverse=True)
        return hits[:limit]

    async def _search_fts(self, query: str) -> list[tuple[str, float, str]]:
        stmt = text(
            """
            SELECT m.conversation_id, ts_rank(to_tsvector('english', m.text), q) AS score,
                   ts_headline('english', m.text, q, 'MaxWords=35, MinWords=12') AS snippet
            FROM handoff_messages m, websearch_to_tsquery('english', :query) q
            WHERE to_tsvector('english', m.text) @@ q
            ORDER BY score DESC
            LIMIT :candidates
            """
        )
        async with self._session() as s:
            rows = (await s.execute(stmt, {"query": query, "candidates": _CANDIDATES})).all()
        return [(cid, float(score), snippet) for cid, score, snippet in rows]

    async def _search_like(self, query: str) -> list[tuple[str, float, str]]:
        terms = _terms(query)
        if not terms:
            return []
        stmt = select(_Message.conversation_id, _Message.text)
        for t in terms:
            stmt = stmt.where(func.lower(_Message.text).contains(t))
        async with self._session() as s:
            rows = (await s.execute(stmt.limit(_CANDIDATES))).all()
        return [(cid, float(sum(body.lower().count(t) for t in terms)), _snippet(body, terms[0])) for cid, body in rows]


def _terms(query: str) -> list[str]:
    return [t for t in re.findall(r"\w+", query.lower()) if len(t) > 1]


def _snippet(body: str, term: str) -> str:
    at = max(0, body.lower().find(term) - _SNIPPET_CHARS // 3)
    return body[at:at + _SNIPPET_CHARS].strip()
