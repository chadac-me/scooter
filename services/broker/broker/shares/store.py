"""Static-share store: the broker-side persistence for published static bundles.

A share is identified by a broker-minted UUID and carries metadata plus one or more
versions, each a snapshot of the bundle's files; updating a share adds a version and
keeps the UUID. The tables live in lib/sql/broker/schema.sql and are created by the
db-migrator, so this store issues no DDL and callers use the dataclass API, never a row.
"""

from __future__ import annotations

import base64
import json
import uuid as uuidlib
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine

from scooter_broker_lib.store import StoreConfig, open_sessions

# Generated ORM models from lib/sql/broker/schema.sql.
from scooter_schema.broker import (
    StaticShares as _ShareRow,
    StaticShareVersions as _VersionRow,
)



@dataclass
class ShareFile:
    """One file in a bundle, with `data` as raw bytes."""

    path: str
    content_type: str
    data: bytes = b""

    @property
    def size(self) -> int:
        return len(self.data)


@dataclass
class ShareVersion:
    """A single published snapshot of a share's files."""

    version: int
    entry_point: str
    files: dict[str, ShareFile]  # {path: ShareFile}
    created_at: str = ""

    def manifest(self) -> list[dict]:
        """The file list without bytes, for metadata responses."""
        return [
            {"path": f.path, "content_type": f.content_type, "size": f.size}
            for f in self.files.values()
        ]


@dataclass
class Share:
    """A published static share, whose broker-minted `uuid` is the URL."""

    uuid: str
    owner: str
    conversation_id: str
    description: str
    visibility: str  # 'public' | 'private'
    latest_version: int
    created_at: str = ""
    updated_at: str = ""

    def summary(self) -> dict:
        """Metadata without file bytes, for list responses."""
        return {
            "uuid": self.uuid,
            "owner": self.owner,
            "conversation_id": self.conversation_id,
            "description": self.description,
            "visibility": self.visibility,
            "latest_version": self.latest_version,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


def _encode_files(files: dict[str, ShareFile]) -> str:
    """Serialize a bundle to a JSON blob with base64 bytes."""
    return json.dumps(
        {
            f.path: {
                "content_type": f.content_type,
                "b64": base64.b64encode(f.data).decode("ascii"),
            }
            for f in files.values()
        }
    )


def _decode_files(blob: str) -> dict[str, ShareFile]:
    raw = json.loads(blob or "{}")
    return {
        path: ShareFile(
            path=path,
            content_type=meta.get("content_type", "application/octet-stream"),
            data=base64.b64decode(meta.get("b64", "")),
        )
        for path, meta in raw.items()
    }


def _to_share(row: _ShareRow) -> Share:
    return Share(
        uuid=row.uuid,
        owner=row.owner,
        conversation_id=row.conversation_id or "",
        description=row.description or "",
        visibility=row.visibility,
        latest_version=row.latest_version,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _to_version(row: _VersionRow) -> ShareVersion:
    return ShareVersion(
        version=row.version,
        entry_point=row.entry_point,
        files=_decode_files(row.files_json),
        created_at=row.created_at,
    )


class ShareStore:
    """Persists static shares and their versions through the generated models, never creating tables."""

    def __init__(self, config: StoreConfig) -> None:
        self._engine: AsyncEngine
        self._engine, self._session = open_sessions(config)

    async def get(self, uuid: str) -> Share | None:
        async with self._session() as s:
            row = await s.get(_ShareRow, uuid)
            return _to_share(row) if row else None

    async def get_version(self, uuid: str, version: int | None = None) -> ShareVersion | None:
        """A specific version (the latest when `version` is None), or None if the share or version does not exist."""
        async with self._session() as s:
            share = await s.get(_ShareRow, uuid)
            if share is None:
                return None
            want = version if version is not None else share.latest_version
            row = (
                await s.execute(
                    select(_VersionRow).where(
                        _VersionRow.share_uuid == uuid, _VersionRow.version == want
                    )
                )
            ).scalar_one_or_none()
            return _to_version(row) if row else None

    async def list_by_owner(self, owner: str) -> list[Share]:
        """A caller's own shares, newest-updated first."""
        async with self._session() as s:
            rows = list(
                (await s.execute(select(_ShareRow).where(_ShareRow.owner == owner))).scalars()
            )
        shares = [_to_share(r) for r in rows]
        shares.sort(key=lambda m: m.updated_at, reverse=True)
        return shares

    async def create(
        self,
        *,
        owner: str,
        conversation_id: str,
        description: str,
        visibility: str,
        files: dict[str, ShareFile],
        entry_point: str,
        now_iso: str = "",
    ) -> Share:
        """Mint a new UUID and store version 1 under the caller-resolved owner."""
        new_uuid = str(uuidlib.uuid4())
        async with self._session() as s, s.begin():
            s.add(
                _ShareRow(
                    uuid=new_uuid, owner=owner, conversation_id=conversation_id,
                    description=description, visibility=visibility, latest_version=1,
                    created_at=now_iso, updated_at=now_iso,
                )
            )
            s.add(
                _VersionRow(
                    share_uuid=new_uuid, version=1, entry_point=entry_point,
                    files_json=_encode_files(files), created_at=now_iso,
                )
            )
        return Share(
            uuid=new_uuid, owner=owner, conversation_id=conversation_id,
            description=description, visibility=visibility, latest_version=1,
            created_at=now_iso, updated_at=now_iso,
        )

    async def add_version(
        self,
        uuid: str,
        *,
        owner: str,
        files: dict[str, ShareFile],
        entry_point: str,
        description: str | None = None,
        now_iso: str = "",
    ) -> Share:
        """Add the next version to an existing share, raising KeyError if unknown and PermissionError if not the owner."""
        async with self._session() as s, s.begin():
            row = await s.get(_ShareRow, uuid)
            if row is None:
                raise KeyError(uuid)
            if row.owner != owner:
                raise PermissionError(f"share '{uuid}' is owned by another user")
            next_version = row.latest_version + 1
            s.add(
                _VersionRow(
                    share_uuid=uuid, version=next_version, entry_point=entry_point,
                    files_json=_encode_files(files), created_at=now_iso,
                )
            )
            row.latest_version = next_version
            row.updated_at = now_iso
            if description is not None:
                row.description = description
            return _to_share(row)

    async def delete(self, uuid: str, *, owner: str) -> bool:
        """Delete a share and all its versions, returning False if unknown and raising PermissionError if not the owner."""
        async with self._session() as s, s.begin():
            row = await s.get(_ShareRow, uuid)
            if row is None:
                return False
            if row.owner != owner:
                raise PermissionError(f"share '{uuid}' is owned by another user")
            for vrow in (
                await s.execute(select(_VersionRow).where(_VersionRow.share_uuid == uuid))
            ).scalars():
                await s.delete(vrow)
            await s.delete(row)
            return True
