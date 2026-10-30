"""Permission-request store: the durable record of the request lifecycle.

Backed by this contrib's own `contrib_aws` database (DDL in contrib/aws/sql) via
SQLAlchemy async, with SQLite as the
local default. STS credentials are never stored here; they live in service.py's
in-memory cache.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import String, Text, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from scooter_broker_lib.store import StoreConfig, open_sessions
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .models import PermissionRequest, RequestStatus, RiskLevel


class _Base(DeclarativeBase):
    pass


class _Row(_Base):
    __tablename__ = "permission_requests"

    request_id: Mapped[str] = mapped_column(String, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(String, index=True)
    target_account: Mapped[str] = mapped_column(String, index=True)
    justification: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String, index=True)
    risk_level: Mapped[str] = mapped_column(String)
    # JSON-encoded text, portable across SQLite and Postgres.
    policy_document: Mapped[str | None] = mapped_column(Text, nullable=True)
    managed_policy_arns: Mapped[str] = mapped_column(Text, default="[]")
    policy_summary: Mapped[str] = mapped_column(Text, default="")
    conversation_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    parent_request_id: Mapped[str | None] = mapped_column(String, nullable=True)
    requested_at: Mapped[str] = mapped_column(String, default="")
    approved_at: Mapped[str | None] = mapped_column(String, nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String, nullable=True)
    denied_at: Mapped[str | None] = mapped_column(String, nullable=True)
    denied_by: Mapped[str | None] = mapped_column(String, nullable=True)
    deny_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    revoked_at: Mapped[str | None] = mapped_column(String, nullable=True)
    iam_role_arn: Mapped[str | None] = mapped_column(String, nullable=True)
    iam_policy_arn: Mapped[str | None] = mapped_column(String, nullable=True)
    role_expires_at: Mapped[str | None] = mapped_column(String, nullable=True)
    credentials_issued_at: Mapped[str | None] = mapped_column(String, nullable=True)
    expires_at: Mapped[str | None] = mapped_column(String, nullable=True)
    approval_obligations: Mapped[str | None] = mapped_column(Text, nullable=True)


class _ApprovalRow(_Base):
    """One approver's approval and the obligations it satisfied."""

    __tablename__ = "aws_request_approvals"

    request_id: Mapped[str] = mapped_column(String, primary_key=True)
    approver: Mapped[str] = mapped_column(String, primary_key=True)
    approved_at: Mapped[str] = mapped_column(String)
    obligation_ids: Mapped[str] = mapped_column(Text)


def _to_model(row: _Row, approvals: list[_ApprovalRow] = ()) -> PermissionRequest:
    return PermissionRequest(
        request_id=row.request_id,
        conversation_id=row.conversation_id,
        target_account=row.target_account,
        justification=row.justification,
        status=RequestStatus(row.status),
        risk_level=RiskLevel(row.risk_level),
        policy_document=json.loads(row.policy_document) if row.policy_document else None,
        managed_policy_arns=json.loads(row.managed_policy_arns or "[]"),
        policy_summary=row.policy_summary,
        conversation_url=row.conversation_url,
        parent_request_id=row.parent_request_id,
        requested_at=row.requested_at,
        approved_at=row.approved_at,
        approved_by=row.approved_by,
        denied_at=row.denied_at,
        denied_by=row.denied_by,
        deny_reason=row.deny_reason,
        revoked_at=row.revoked_at,
        iam_role_arn=row.iam_role_arn,
        iam_policy_arn=row.iam_policy_arn,
        role_expires_at=row.role_expires_at,
        credentials_issued_at=row.credentials_issued_at,
        expires_at=row.expires_at,
        approval_obligations=json.loads(row.approval_obligations) if row.approval_obligations else None,
        approvals=[
            {"approver": a.approver, "approved_at": a.approved_at, "obligations": json.loads(a.obligation_ids)}
            for a in sorted(approvals, key=lambda a: a.approved_at)
        ],
    )


# Columns stored as JSON-encoded text.
_JSON_FIELDS = {"policy_document", "managed_policy_arns", "approval_obligations"}


def _row_kwargs(req: PermissionRequest) -> dict[str, Any]:
    return {
        "request_id": req.request_id,
        "conversation_id": req.conversation_id,
        "target_account": req.target_account,
        "justification": req.justification,
        "status": req.status.value,
        "risk_level": req.risk_level.value,
        "policy_document": json.dumps(req.policy_document) if req.policy_document is not None else None,
        "managed_policy_arns": json.dumps(req.managed_policy_arns),
        "policy_summary": req.policy_summary,
        "conversation_url": req.conversation_url,
        "parent_request_id": req.parent_request_id,
        "requested_at": req.requested_at,
        "approved_at": req.approved_at,
        "approved_by": req.approved_by,
        "denied_at": req.denied_at,
        "denied_by": req.denied_by,
        "deny_reason": req.deny_reason,
        "revoked_at": req.revoked_at,
        "iam_role_arn": req.iam_role_arn,
        "iam_policy_arn": req.iam_policy_arn,
        "role_expires_at": req.role_expires_at,
        "credentials_issued_at": req.credentials_issued_at,
        "expires_at": req.expires_at,
        "approval_obligations": json.dumps(req.approval_obligations) if req.approval_obligations is not None else None,
    }


async def _models(s, rows: list[_Row]) -> list[PermissionRequest]:
    """Rows as models, each with its recorded approvals."""
    ids = [r.request_id for r in rows]
    by_id: dict[str, list[_ApprovalRow]] = {}
    if ids:
        for a in (await s.execute(select(_ApprovalRow).where(_ApprovalRow.request_id.in_(ids)))).scalars():
            by_id.setdefault(a.request_id, []).append(a)
    return [_to_model(r, by_id.get(r.request_id, [])) for r in rows]


class PermissionStore:
    """Persists PermissionRequest rows; get_for_conversation only returns a request to the conversation that created it."""

    def __init__(self, config: StoreConfig) -> None:
        self._engine: AsyncEngine
        self._engine, self._session = open_sessions(config)

    async def insert(self, request: PermissionRequest) -> None:
        async with self._session() as s, s.begin():
            s.add(_Row(**_row_kwargs(request)))

    async def get(self, request_id: str) -> PermissionRequest | None:
        async with self._session() as s:
            row = await s.get(_Row, request_id)
            return (await _models(s, [row]))[0] if row else None

    async def get_for_conversation(self, request_id: str, conversation_id: str) -> PermissionRequest | None:
        async with self._session() as s:
            row = await s.get(_Row, request_id)
            if row is None or row.conversation_id != conversation_id:
                return None
            return (await _models(s, [row]))[0]

    async def update(self, request_id: str, **fields: Any) -> None:
        async with self._session() as s, s.begin():
            row = await s.get(_Row, request_id)
            if row is None:
                return
            for k, v in fields.items():
                if k in _JSON_FIELDS:
                    v = json.dumps(v) if v is not None else None
                elif isinstance(v, (RequestStatus, RiskLevel)):
                    v = v.value
                setattr(row, k, v)

    async def add_approval(self, request_id: str, approver: str, approved_at: str, obligation_ids: list[str]) -> bool:
        """Record an approval; False if this approver already approved."""
        try:
            async with self._session() as s, s.begin():
                s.add(_ApprovalRow(
                    request_id=request_id, approver=approver, approved_at=approved_at,
                    obligation_ids=json.dumps(obligation_ids),
                ))
        except IntegrityError:
            return False
        return True

    async def list_for_conversation(self, conversation_id: str) -> list[PermissionRequest]:
        async with self._session() as s:
            rows = (await s.execute(select(_Row).where(_Row.conversation_id == conversation_id))).scalars()
            return await _models(s, list(rows))

    async def list_expired_active(self, now_iso: str) -> list[PermissionRequest]:
        async with self._session() as s:
            stmt = select(_Row).where(
                _Row.status.in_([RequestStatus.ACTIVE.value, RequestStatus.APPROVED.value]),
                _Row.role_expires_at.is_not(None),
                _Row.role_expires_at <= now_iso,
            )
            return await _models(s, list((await s.execute(stmt)).scalars()))

    async def query_audit(
        self,
        *,
        conversation_id: str | None = None,
        target_account: str | None = None,
        status: RequestStatus | None = None,
        limit: int = 100,
    ) -> list[PermissionRequest]:
        async with self._session() as s:
            stmt = select(_Row)
            if conversation_id:
                stmt = stmt.where(_Row.conversation_id == conversation_id)
            if target_account:
                stmt = stmt.where(_Row.target_account == target_account)
            if status:
                stmt = stmt.where(_Row.status == status.value)
            stmt = stmt.order_by(_Row.requested_at.desc()).limit(limit)
            return await _models(s, list((await s.execute(stmt)).scalars()))
