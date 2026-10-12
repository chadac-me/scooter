"""Module registry store: the broker-side catalog of shareable modules.

A module has a globally unique `name` owned by its first publisher and a stable numeric
`id`, and can be referenced by either; it carries metadata plus its Nix files as a JSON
blob. Visibility gates the catalog listing, while the download path serves any ref.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from sqlalchemy import Integer, String, Text, select
from sqlalchemy.ext.asyncio import AsyncEngine

from scooter_broker_lib.store import StoreConfig, open_sessions
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column



@dataclass
class Module:
    """A registry module, where `name` is the canonical ref and `id` a stable numeric handle."""

    id: int
    name: str
    owner: str
    description: str
    visibility: str  # 'private' | 'public'
    version: int
    files: dict[str, str] = field(default_factory=dict)  # {filename: contents}
    created_at: str = ""
    updated_at: str = ""

    def summary(self) -> dict:
        """Metadata without the file blob, for catalog responses."""
        return {
            "id": self.id,
            "name": self.name,
            "owner": self.owner,
            "description": self.description,
            "visibility": self.visibility,
            "version": self.version,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class _Base(DeclarativeBase):
    pass


class _ModuleRow(_Base):
    __tablename__ = "module_registry"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, unique=True, index=True)
    owner: Mapped[str] = mapped_column(String, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    visibility: Mapped[str] = mapped_column(String, default="private", index=True)
    version: Mapped[int] = mapped_column(default=1)
    files_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[str] = mapped_column(String, default="")
    updated_at: Mapped[str] = mapped_column(String, default="")


def _to_module(row: _ModuleRow) -> Module:
    return Module(
        id=row.id,
        name=row.name,
        owner=row.owner,
        description=row.description or "",
        visibility=row.visibility,
        version=row.version,
        files=json.loads(row.files_json or "{}"),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class ModuleRegistryStore:
    """Persists registry modules."""

    def __init__(self, config: StoreConfig) -> None:
        self._engine: AsyncEngine
        self._engine, self._session = open_sessions(config)

    async def get(self, ref: str) -> Module | None:
        """Resolve a module by numeric id or by name."""
        async with self._session() as s:
            row = None
            if ref.isdigit():
                row = await s.get(_ModuleRow, int(ref))
            if row is None:
                row = (await s.execute(select(_ModuleRow).where(_ModuleRow.name == ref))).scalar_one_or_none()
            return _to_module(row) if row else None

    async def get_files(self, ref: str) -> dict[str, str] | None:
        """The files blob, or None if the module does not exist."""
        m = await self.get(ref)
        return m.files if m else None

    async def list_visible(self, viewer: str, query: str = "") -> list[Module]:
        """Modules visible to `viewer` (their own plus all public), optionally filtered by a case-insensitive substring of name or description."""
        async with self._session() as s:
            stmt = select(_ModuleRow).where(
                (_ModuleRow.owner == viewer) | (_ModuleRow.visibility == "public")
            )
            rows = list((await s.execute(stmt)).scalars())
        mods = [_to_module(r) for r in rows]
        if query:
            q = query.lower()
            mods = [m for m in mods if q in m.name.lower() or q in m.description.lower()]
        mods.sort(key=lambda m: m.updated_at, reverse=True)
        return mods

    async def publish(
        self,
        *,
        owner: str,
        name: str,
        description: str,
        visibility: str,
        files: dict[str, str],
        now_iso: str = "",
    ) -> Module:
        """Create `name` or, for its owner, re-publish it with a bumped version, rejecting a different owner."""
        payload = json.dumps(files)
        async with self._session() as s, s.begin():
            row = (await s.execute(select(_ModuleRow).where(_ModuleRow.name == name))).scalar_one_or_none()
            if row is None:
                row = _ModuleRow(
                    name=name, owner=owner, description=description,
                    visibility=visibility, version=1, files_json=payload,
                    created_at=now_iso, updated_at=now_iso,
                )
                s.add(row)
            else:
                if row.owner != owner:
                    raise PermissionError(f"module '{name}' is owned by another user")
                row.description = description
                row.visibility = visibility
                row.files_json = payload
                row.version += 1
                row.updated_at = now_iso
            await s.flush()
            return _to_module(row)
