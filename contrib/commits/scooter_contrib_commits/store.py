"""Each user's commit identity, in this contrib's own `contrib_commits` database.

The DDL lives in contrib/commits/sql/schema.sql (Atlas owns it); this module never
creates tables. The user may always overwrite an identity. An agent only proposes
one; the user's approval writes it if none is set by then, and supersedes that
user's other pending proposals.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import String, delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.commit_identity import Person
from scooter_broker_lib.store import StoreConfig, open_sessions

SET_BY = ("user", "agent")
STATUSES = ("pending", "approved", "denied", "superseded")

# Git idents cannot hold <, > or newlines.
_NAME = re.compile(r"^[^<>\n\r\x00]{1,200}$")
_EMAIL = re.compile(r"^[^\s<>@]{1,200}@[^\s<>@]{1,200}$")


class InvalidIdentity(ValueError):
    pass


class Refused(Exception):
    """A proposal or decision that cannot apply; the message says why."""


class NotYours(Refused):
    """A decision by someone other than the proposal's user."""


def validated(name: str, email: str) -> Person:
    name, email = (name or "").strip(), (email or "").strip()
    if not _NAME.match(name):
        raise InvalidIdentity("name must be one line of 1-200 characters, without < or >")
    if not _EMAIL.match(email):
        raise InvalidIdentity("email must look like user@host")
    return Person(name, email)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class _Base(DeclarativeBase):
    pass


class _Identity(_Base):
    __tablename__ = "commit_identities"

    user_id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    email: Mapped[str] = mapped_column(String)
    set_by: Mapped[str] = mapped_column(String)
    updated_at: Mapped[str] = mapped_column(String)


class _Proposal(_Base):
    __tablename__ = "commit_identity_proposals"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String)
    conversation_id: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    email: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String)
    created_at: Mapped[str] = mapped_column(String)
    decided_at: Mapped[str | None] = mapped_column(String, nullable=True)


@dataclass(frozen=True)
class ChosenIdentity:
    person: Person
    set_by: str
    updated_at: str

    def payload(self) -> dict:
        return {"name": self.person.name, "email": self.person.email, "set_by": self.set_by, "updated_at": self.updated_at}


@dataclass(frozen=True)
class Proposal:
    id: str
    user_id: str
    conversation_id: str
    person: Person
    status: str


@dataclass(frozen=True)
class Decision:
    """An approval's result: the identity now set, and the proposals it superseded."""

    identity: ChosenIdentity
    superseded: list[Proposal]


def _chosen(row: _Identity) -> ChosenIdentity:
    return ChosenIdentity(Person(row.name, row.email), row.set_by, row.updated_at)


def _proposal(row: _Proposal) -> Proposal:
    return Proposal(row.id, row.user_id, row.conversation_id, Person(row.name, row.email), row.status)


def _row(user_id: str, person: Person, set_by: str) -> _Identity:
    return _Identity(user_id=user_id, name=person.name, email=person.email, set_by=set_by, updated_at=_now())


class CommitIdentityStore:
    def __init__(self, config: StoreConfig) -> None:
        self._engine, self._session = open_sessions(config)

    async def get(self, user_id: str) -> ChosenIdentity | None:
        async with self._session() as s:
            row = await s.get(_Identity, user_id)
        return _chosen(row) if row else None

    async def set(self, user_id: str, person: Person) -> tuple[ChosenIdentity, list[Proposal]]:
        """The user's own choice: replaces any identity and supersedes every pending proposal."""
        row = _row(user_id, person, "user")
        async with self._session() as s, s.begin():
            await _lock(s, user_id)
            await s.merge(row)
            superseded = await _supersede(s, user_id, keep=None)
        return _chosen(row), superseded

    async def clear(self, user_id: str) -> None:
        async with self._session() as s, s.begin():
            await s.execute(delete(_Identity).where(_Identity.user_id == user_id))

    async def propose(self, user_id: str, conversation_id: str, person: Person) -> Proposal:
        """An agent's guess, pending approval; Refused once an identity is set or this conversation already asked."""
        async with self._session() as s, s.begin():
            if await s.get(_Identity, user_id) is not None:
                raise Refused("an identity is already set")
            mine = await s.scalar(select(_Proposal).where(
                _Proposal.user_id == user_id,
                _Proposal.conversation_id == conversation_id,
                _Proposal.status == "pending",
            ))
            if mine is not None:
                raise Refused(f"this conversation's proposal of {_proposal(mine).person.ident()} is still pending")
            row = _Proposal(
                id=str(uuid.uuid4()), user_id=user_id, conversation_id=conversation_id,
                name=person.name, email=person.email, status="pending", created_at=_now(),
            )
            s.add(row)
        return _proposal(row)

    async def proposal(self, proposal_id: str) -> Proposal | None:
        async with self._session() as s:
            row = await s.get(_Proposal, proposal_id)
        return _proposal(row) if row else None

    async def pending(self, *, conversation_id: str | None = None, user_id: str | None = None) -> list[Proposal]:
        q = select(_Proposal).where(_Proposal.status == "pending").order_by(_Proposal.created_at)
        if conversation_id is not None:
            q = q.where(_Proposal.conversation_id == conversation_id)
        if user_id is not None:
            q = q.where(_Proposal.user_id == user_id)
        async with self._session() as s:
            return [_proposal(r) for r in (await s.scalars(q)).all()]

    async def approve(self, proposal_id: str, approver: str) -> Decision:
        """Write the proposed identity and supersede the user's other proposals, all or nothing.

        Decisions for one user take turns on _lock; the identity's key is the backstop.
        """
        try:
            async with self._session() as s, s.begin():
                row = await _claim(s, proposal_id, approver, "approved")
                identity = _row(row.user_id, Person(row.name, row.email), "agent")
                s.add(identity)
                await s.flush()
                superseded = await _supersede(s, row.user_id, keep=proposal_id)
        except IntegrityError:
            async with self._session() as s, s.begin():
                await s.execute(
                    update(_Proposal)
                    .where(_Proposal.id == proposal_id, _Proposal.status == "pending")
                    .values(status="superseded", decided_at=_now())
                )
            raise Refused("an identity was set first") from None
        return Decision(_chosen(identity), superseded)

    async def deny(self, proposal_id: str, approver: str) -> None:
        async with self._session() as s, s.begin():
            await _claim(s, proposal_id, approver, "denied")


async def _claim(s: AsyncSession, proposal_id: str, approver: str, status: str) -> _Proposal:
    """Move the approver's own pending proposal to `status`; Refused otherwise."""
    row = await s.get(_Proposal, proposal_id)
    if row is None or row.user_id != approver:
        raise NotYours("no such proposal for this user")
    await _lock(s, row.user_id)
    await s.refresh(row)
    claimed = await s.execute(
        update(_Proposal)
        .where(_Proposal.id == proposal_id, _Proposal.status == "pending")
        .values(status=status, decided_at=_now())
        .execution_options(synchronize_session=False)
    )
    if claimed.rowcount != 1:
        raise Refused(f"this proposal is already {row.status}")
    return row


async def _lock(s: AsyncSession, user_id: str) -> None:
    """Hold the user's pending proposals until commit, so their decisions take turns."""
    await s.execute(
        select(_Proposal.id)
        .where(_Proposal.user_id == user_id, _Proposal.status == "pending")
        .order_by(_Proposal.id)
        .with_for_update()
    )


async def _supersede(s: AsyncSession, user_id: str, keep: str | None) -> list[Proposal]:
    q = select(_Proposal).where(_Proposal.user_id == user_id, _Proposal.status == "pending")
    if keep is not None:
        q = q.where(_Proposal.id != keep)
    rows = (await s.scalars(q)).all()
    for r in rows:
        r.status, r.decided_at = "superseded", _now()
    return [_proposal(r) for r in rows]
