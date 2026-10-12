"""Shared async-DB plumbing: the broker DSN, and the one place an engine is built.

Every broker store reaches the same `broker` database and needs the same reconnect
guards (`pool_pre_ping` and `pool_recycle`, without which a connection Postgres
already closed is handed out and the service stays broken until restarted), so
every store opens its engine through `open_sessions`.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# Under typical idle-timeout windows.
POOL_RECYCLE_SECONDS = 1800


@dataclass
class StoreConfig:
    """DSN assembly: an explicit `dsn` wins, otherwise a Postgres DSN is built from the components when `db_password` (its own field so a secretKeyRef can supply it) is set."""

    dsn: str = "sqlite+aiosqlite:////tmp/broker-aws.db"
    db_host: str = "agent-shared-db.agent-manager.svc.cluster.local"
    db_port: int = 5432
    db_user: str = "webhooks"   # the shared instance's user
    db_password: str = ""
    db_name: str = "broker"     # a separate database on the shared Postgres
    db_sslmode: str = ""        # "require" etc.; empty adds no ssl param

    def resolved_dsn(self) -> str:
        if self.db_password and not self.dsn.startswith("postgresql"):
            dsn = (
                f"postgresql+asyncpg://{self.db_user}:{self.db_password}"
                f"@{self.db_host}:{self.db_port}/{self.db_name}"
            )
            # asyncpg takes ssl as a query param, not libpq's sslmode=.
            if self.db_sslmode:
                dsn += f"?ssl={self.db_sslmode}"
            return dsn
        return self.dsn


def open_sessions(
    config: StoreConfig,
) -> tuple[AsyncEngine, async_sessionmaker[AsyncSession]]:
    """The engine and session factory for `config` with the reconnect guards applied; `expire_on_commit=False` keeps a row readable after its transaction closes."""
    engine = create_async_engine(
        config.resolved_dsn(),
        echo=False,
        pool_pre_ping=True,
        pool_recycle=POOL_RECYCLE_SECONDS,
    )
    return engine, async_sessionmaker(engine, expire_on_commit=False)
