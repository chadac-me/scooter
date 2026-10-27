"""Pydantic API models and SQLAlchemy ORM tables for scheduled tasks and runs."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


# --- ORM ----------------------------------------------------------------------

class Base(DeclarativeBase):
    pass


class TaskRow(Base):
    __tablename__ = "scheduled_tasks"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    # NULL only for a system task that runs on interval_seconds.
    cron: Mapped[str | None] = mapped_column(String)
    timezone: Mapped[str] = mapped_column(String, nullable=False, default="UTC")
    # The user who created the task, and the owner of every conversation it spawns.
    owner: Mapped[str] = mapped_column(String, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # 'user' (a prompt a user scheduled) or 'system' (a command synced from scooter.systemTasks).
    kind: Mapped[str] = mapped_column(String, nullable=False, default="user", server_default="user")
    # System tasks only.
    command: Mapped[str | None] = mapped_column(Text)
    args: Mapped[str | None] = mapped_column(Text)  # a JSON array
    interval_seconds: Mapped[int | None] = mapped_column(Integer)
    timeout_seconds: Mapped[int | None] = mapped_column(Integer)
    model: Mapped[str | None] = mapped_column(String)
    # Why this image cannot run the task (its command is missing), else None.
    unavailable: Mapped[str | None] = mapped_column(Text)
    # User tasks: conversation to prompt; None spawns a new one.
    conversation_id: Mapped[str | None] = mapped_column(String)


class RunRow(Base):
    __tablename__ = "task_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    task_id: Mapped[str] = mapped_column(String, ForeignKey("scheduled_tasks.id", ondelete="CASCADE"), nullable=False)
    conversation_id: Mapped[str | None] = mapped_column(String)
    # User task: spawning|spawned|delivered|failed. System task: running|succeeded|failed|timed_out.
    status: Mapped[str] = mapped_column(String, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    fired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    exit_code: Mapped[int | None] = mapped_column(Integer)
    # sha256 of the secret a running system task records its spawns with; cleared when it ends.
    report_token_sha256: Mapped[str | None] = mapped_column(String)


class RunConversationRow(Base):
    """A conversation a system-task run opened, and for whom."""

    __tablename__ = "task_run_conversations"

    run_id: Mapped[str] = mapped_column(String, ForeignKey("task_runs.id", ondelete="CASCADE"), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(String, primary_key=True)
    owner: Mapped[str | None] = mapped_column(String, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# --- API models ---------------------------------------------------------------

class TaskCreate(BaseModel):
    title: str
    prompt: str
    cron: str
    timezone: str = "UTC"
    enabled: bool = True
    # Conversation to prompt instead of spawning; caller checks ownership.
    conversation_id: str | None = None
    # owner is the authenticated request identity, never accepted from the body.


class TaskPatch(BaseModel):
    title: str | None = None
    prompt: str | None = None
    cron: str | None = None
    timezone: str | None = None
    enabled: bool | None = None
    # Declared only so a patch naming it is refused.
    conversation_id: str | None = None


class Task(BaseModel):
    id: str
    title: str
    prompt: str
    cron: str
    timezone: str
    owner: str
    enabled: bool
    next_run_at: datetime | None
    last_run_at: datetime | None
    conversation_id: str | None = None

    @classmethod
    def of(cls, r: TaskRow) -> "Task":
        return cls(
            id=r.id, title=r.title, prompt=r.prompt, cron=r.cron, timezone=r.timezone,
            owner=r.owner, enabled=r.enabled, next_run_at=r.next_run_at, last_run_at=r.last_run_at,
            conversation_id=r.conversation_id,
        )


class Run(BaseModel):
    id: str
    task_id: str
    conversation_id: str | None
    status: str
    error: str | None
    fired_at: datetime

    @classmethod
    def of(cls, r: RunRow) -> "Run":
        return cls(
            id=r.id, task_id=r.task_id, conversation_id=r.conversation_id,
            status=r.status, error=r.error, fired_at=r.fired_at,
        )


class RunConversation(BaseModel):
    """POST /runs/{run_id}/conversations: a conversation a system-task run opened."""

    conversation_id: str
    owner: str | None = None


def new_id() -> str:
    return str(uuid.uuid4())
