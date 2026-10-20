"""Broker configuration: secrets and enable/disable flags, while providers own their upstream URLs."""

from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic_settings import BaseSettings

from scooter_lib.settings import ScooterBaseSettings

if TYPE_CHECKING:  # import at runtime would pull sqlalchemy into every config import
    from scooter_broker_lib.store import StoreConfig


class BrokerSettings(ScooterBaseSettings):
    # Auth
    token_audience: str = "agent-broker"
    sandbox_namespace: str = "agent-sandbox"

    # SA usernames admitted as non-sandbox callers acting for a user (CSV of
    # system:serviceaccount:{ns}:{name}), which sets Identity.is_approver.
    approver_service_accounts: str = ""

    # --- The agent-facing MCP server (broker/mcp/) --------------------------
    # Contrib-contributed agent tools served at POST /mcp to one conversation at a time.
    mcp_enabled: bool = True

    # SA usernames allowed to act for a conversation by presenting a conversation token
    # (CSV of system:serviceaccount:{ns}:{name}), a separate authorization from
    # approver_service_accounts even though both name the agent-host.
    mcp_caller_service_accounts: str = ""

    # The HS256 secret the agent-host signs conversation tokens with; empty fails closed.
    conv_token_secret: str = ""

    # The `test` whoami provider, off in prod.
    test_provider_enabled: bool = False

    # --- The shared `broker` database ---------------------------------------
    # Components for the platform Postgres database named `broker`, which every broker
    # store uses; the SQLite default is the dev path and a set password wins (see store_config).
    broker_db_dsn: str = "sqlite+aiosqlite:////tmp/broker.db"
    broker_db_host: str = "agent-shared-db.agent-manager.svc.cluster.local"
    broker_db_port: int = 5432
    broker_db_user: str = "broker"
    broker_db_password: str = ""
    broker_db_name: str = "broker"
    broker_db_sslmode: str = ""  # e.g. "require" for RDS; empty means no ssl param
    # --- OpenFGA authorization --------------------------------------------
    # Off by default, which selects the NoopAuthorizer.
    fga_enabled: bool = False
    fga_api_url: str = ""             # e.g. http://openfga.agent-manager.svc:8080
    fga_store_id: str = ""
    fga_authorization_model_id: str = ""

    # --- Sandbox-adjacent settings --------------------------------------------
    # A mounted directory of `.nix` files served unauthenticated as the deployment's
    # default modules at GET /modules/default.tar.gz; empty serves an empty tarball.
    sandbox_default_modules_dir: str = ""

    # --- Static shares (broker/shares/) ----------------------------------------
    # Agents publish static bundles the broker serves at /s/<uuid>/; `shares_public_base_url`
    # is the external origin of the returned share URL, or empty for a relative one.
    shares_enabled: bool = False
    shares_db_dsn: str = "sqlite+aiosqlite:////tmp/broker-shares.db"
    shares_public_base_url: str = ""
    # The CSP frame-ancestors allowlist for a served share, which is meant to be embedded
    # only inside the Scooter conversation UI (space-separated origins, or 'self').
    shares_frame_ancestors: str = "'self'"

    port: int = 8080

    def store_config(self, dsn: str = "") -> "StoreConfig":
        """The shared-Postgres components as a StoreConfig, where `dsn` is the store's own dev-SQLite default that loses to Postgres whenever a password is set."""
        from scooter_broker_lib.store import StoreConfig

        return StoreConfig(
            dsn=dsn or self.broker_db_dsn,
            db_host=self.broker_db_host,
            db_port=self.broker_db_port,
            db_user=self.broker_db_user,
            db_password=self.broker_db_password,
            db_name=self.broker_db_name,
            db_sslmode=self.broker_db_sslmode,
        )


# The process-wide settings snapshot, which `refresh_settings()` updates in place.
settings = BrokerSettings()


def get_settings() -> BrokerSettings:
    """A fresh BrokerSettings read from the current environment."""
    return BrokerSettings()


def refresh_settings() -> BrokerSettings:
    """Re-read the environment into the shared `settings` object in place and return it."""
    fresh = BrokerSettings()
    settings.__dict__.update(fresh.__dict__)
    return settings
