"""Usage store: today's generation counts per user, overall and per backend — what
the "priority" selector (and any other) reads as `Usage`.

The DDL lives in contrib/imagegen/sql/schema.sql (Atlas owns it); `_Base`'s row
model mirrors it (held together by tests/test_db.py) and this module issues no DDL
of its own.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import Index, String, func, select
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.store import StoreConfig, open_sessions


class _Base(DeclarativeBase):
    pass


class _Generation(_Base):
    __tablename__ = "generations"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String)
    backend: Mapped[str] = mapped_column(String)
    model: Mapped[str] = mapped_column(String)
    created_at: Mapped[str] = mapped_column(String)

    __table_args__ = (Index("generations_user_id_created_at_idx", "user_id", "created_at"),)


@dataclass(frozen=True)
class TodayUsage:
    total: int
    per_backend: dict[str, int] = field(default_factory=dict)


def _start_of_today() -> str:
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()


class GenerationStore:
    def __init__(self, config: StoreConfig) -> None:
        self._engine, self._session = open_sessions(config)

    async def usage_today(self, user_id: str) -> TodayUsage:
        start = _start_of_today()
        async with self._session() as session:
            rows = (
                await session.execute(
                    select(_Generation.backend, func.count())
                    .where(_Generation.user_id == user_id, _Generation.created_at >= start)
                    .group_by(_Generation.backend)
                )
            ).all()
        per_backend = {row[0]: row[1] for row in rows}
        return TodayUsage(total=sum(per_backend.values()), per_backend=per_backend)

    async def record(self, user_id: str, backend: str, model: str) -> None:
        async with self._session() as session, session.begin():
            session.add(
                _Generation(
                    id=str(uuid.uuid4()),
                    user_id=user_id,
                    backend=backend,
                    model=model,
                    created_at=datetime.now(timezone.utc).isoformat(),
                )
            )
