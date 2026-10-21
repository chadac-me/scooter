"""Annotation persistence: comments and answers anchored to a file location.

Backed by this contrib's own `contrib_files` database through the StoreConfig the broker hands
this contrib. The table is DECLARED in contrib/files/sql/schema.sql and applied by the
Atlas migration Job — the row model below mirrors it and issues no DDL, the same
split `contrib/aws`'s permission store uses.

The id is supplied by the caller rather than minted here. The viewer pushes from an
outbox and retries on failure, so a broker-minted id would turn every lost ack into
a duplicate comment; with the caller's id, `upsert` is idempotent and a retry is
free. It also reports whether it inserted, which is what keeps a retry from waking
the agent a second time.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import Boolean, Integer, String, Text, select
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.store import StoreConfig, open_sessions

# A comment is review discussion; an answer responds to a `scooter:question` block in
# a document. Both are the same record because they are the same thing to the agent:
# something a human said about a place in a file.
KINDS = {"comment", "answer"}
# Stored in `author` for a remark the agent wrote; a reviewer's holds the conversation.
AGENT_AUTHOR = "agent"


class _Base(DeclarativeBase):
    pass


class _Row(_Base):
    """Mirrors `annotations` in contrib/files/sql/schema.sql; that file is the DDL's source of truth."""

    __tablename__ = "annotations"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(String, index=True)
    path: Mapped[str] = mapped_column(String, index=True)
    # The line is a hint and the quote is the identity — see Anchor.
    anchor_line: Mapped[int] = mapped_column(Integer)
    anchor_quote: Mapped[str] = mapped_column(Text, default="")
    kind: Mapped[str] = mapped_column(String)
    question_id: Mapped[str | None] = mapped_column(String, nullable=True)
    thread: Mapped[str] = mapped_column(String, index=True)
    author: Mapped[str] = mapped_column(String, default="")
    body: Mapped[str] = mapped_column(Text, default="")
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str] = mapped_column(String, default="")
    updated_at: Mapped[str] = mapped_column(String, default="")


@dataclass
class Anchor:
    """Where in the file this is attached.

    The line is a hint and the quote is the identity — the viewer trusts the line
    only if the quote still matches there, and otherwise searches nearby. Carrying
    the quote is also what makes a thread readable after the sandbox is gone, since
    the annotation set then holds a partial shadow of the file.
    """

    line: int
    quote: str

    def payload(self) -> dict:
        return {"line": self.line, "quote": self.quote}


@dataclass
class Annotation:
    """One comment or answer, as the viewer and the API exchange it."""

    id: str
    conversation_id: str
    path: str
    anchor: Anchor
    kind: str
    text: str
    thread: str
    author: str = ""
    # Set for kind='answer': the id of the `scooter:question` block being answered.
    question_id: str = ""
    resolved: bool = False
    created_at: str = ""
    updated_at: str = ""

    @property
    def by(self) -> str:
        return "agent" if self.author == AGENT_AUTHOR else "reviewer"

    def payload(self) -> dict:
        return {
            "id": self.id,
            "conversation": self.conversation_id,
            "path": self.path,
            "anchor": self.anchor.payload(),
            "kind": self.kind,
            "question_id": self.question_id or None,
            "thread": self.thread,
            # Attribution is conversation-level in draft 1: nothing in the proxy or
            # broker chain knows which human clicked.
            "author": {"conversation": self.conversation_id, "by": self.by},
            "by": self.by,
            "text": self.text,
            "resolved": self.resolved,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


def _to_annotation(row: _Row) -> Annotation:
    return Annotation(
        id=row.id,
        conversation_id=row.conversation_id,
        path=row.path,
        anchor=Anchor(line=row.anchor_line, quote=row.anchor_quote or ""),
        kind=row.kind,
        text=row.body or "",
        thread=row.thread,
        author=row.author or "",
        question_id=row.question_id or "",
        resolved=bool(row.resolved),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class AnnotationStore:
    """Persists annotations through the row model above, never creating tables."""

    def __init__(self, config: StoreConfig) -> None:
        self._engine: AsyncEngine
        self._engine, self._session = open_sessions(config)

    async def get(self, annotation_id: str) -> Annotation | None:
        async with self._session() as s:
            row = await s.get(_Row, annotation_id)
            return _to_annotation(row) if row else None

    async def list(
        self,
        conversation_id: str,
        *,
        path: str = "",
        thread: str = "",
        resolved: bool | None = None,
    ) -> list[Annotation]:
        """A conversation's annotations, oldest first so a thread reads in order."""
        async with self._session() as s:
            stmt = select(_Row).where(_Row.conversation_id == conversation_id)
            if path:
                stmt = stmt.where(_Row.path == path)
            if thread:
                stmt = stmt.where(_Row.thread == thread)
            if resolved is not None:
                stmt = stmt.where(_Row.resolved == resolved)
            rows = list((await s.execute(stmt)).scalars())
        items = [_to_annotation(r) for r in rows]
        items.sort(key=lambda a: (a.created_at, a.id))
        return items

    async def upsert(self, annotation: Annotation, *, now_iso: str = "") -> tuple[Annotation, bool]:
        """Store an annotation, returning it and whether this call created it.

        Idempotent by id, because the viewer's outbox retries: re-pushing a record
        the broker already has must not duplicate it, and must not read as new. A
        re-push updates the mutable fields and keeps the original `created_at`.

        Raises PermissionError if the id already exists under another conversation,
        so a caller cannot overwrite a neighbour's annotation by guessing an id.
        """
        async with self._session() as s, s.begin():
            row = await s.get(_Row, annotation.id)
            if row is not None:
                if row.conversation_id != annotation.conversation_id:
                    raise PermissionError(
                        f"annotation '{annotation.id}' belongs to another conversation"
                    )
                row.path = annotation.path
                row.anchor_line = annotation.anchor.line
                row.anchor_quote = annotation.anchor.quote
                row.kind = annotation.kind
                row.question_id = annotation.question_id or None
                row.thread = annotation.thread
                row.author = annotation.author or annotation.conversation_id
                row.body = annotation.text
                row.resolved = annotation.resolved
                row.updated_at = now_iso
                return _to_annotation(row), False

            created = annotation.created_at or now_iso
            s.add(
                _Row(
                    id=annotation.id,
                    conversation_id=annotation.conversation_id,
                    path=annotation.path,
                    anchor_line=annotation.anchor.line,
                    anchor_quote=annotation.anchor.quote,
                    kind=annotation.kind,
                    question_id=annotation.question_id or None,
                    thread=annotation.thread,
                    author=annotation.author or annotation.conversation_id,
                    body=annotation.text,
                    resolved=annotation.resolved,
                    created_at=created,
                    updated_at=now_iso,
                )
            )
        stored = await self.get(annotation.id)
        assert stored is not None  # just written in a committed transaction
        return stored, True

    async def resolve_thread(
        self, conversation_id: str, thread: str, *, resolved: bool, now_iso: str = ""
    ) -> int:
        """Mark every annotation in a thread resolved or open; returns the row count.

        Resolution is a property of the discussion, not of one remark, so it is
        applied to the thread rather than left to the caller to fan out — which
        would let a partly-resolved thread exist and have no meaning.
        """
        async with self._session() as s, s.begin():
            rows = list(
                (
                    await s.execute(
                        select(_Row).where(
                            _Row.conversation_id == conversation_id, _Row.thread == thread
                        )
                    )
                ).scalars()
            )
            for row in rows:
                row.resolved = resolved
                row.updated_at = now_iso
            return len(rows)

    async def delete(self, annotation_id: str, *, conversation_id: str) -> bool:
        """Delete one annotation, returning False if unknown; PermissionError if it is another conversation's."""
        async with self._session() as s, s.begin():
            row = await s.get(_Row, annotation_id)
            if row is None:
                return False
            if row.conversation_id != conversation_id:
                raise PermissionError(
                    f"annotation '{annotation_id}' belongs to another conversation"
                )
            await s.delete(row)
            return True
