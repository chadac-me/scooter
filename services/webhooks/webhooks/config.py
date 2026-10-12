"""Webhooks service configuration.

`DatabaseSettings` structurally satisfies `scooter_webhooks_lib.store.DatabaseConfig`,
and `app.py` hands the settings object to the lib's store and agent-host client at
startup, so the lib never imports this module.
"""

import hmac

from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import model_validator
from pydantic_settings import BaseSettings

from scooter_lib.settings import ScooterBaseSettings

_bearer_scheme = HTTPBearer(auto_error=False)


class DatabaseSettings(BaseSettings):
    """Conversation-mapping store settings: SQLite by default, or a Postgres DSN given directly or assembled from DB_PASSWORD plus the DB_* components so the password can come from a secretKeyRef."""

    dsn: str = "sqlite+aiosqlite:////tmp/webhooks.db"
    db_host: str = "local"
    db_port: int = 5432
    db_user: str = "webhooks"
    db_password: str = ""  # when set, a Postgres DSN is assembled
    db_name: str = "webhooks"
    db_sslmode: str = ""  # e.g. "require" for RDS; empty means no ssl param

    model_config = {"env_prefix": "", "case_sensitive": False}

    @model_validator(mode="after")
    def _assemble_dsn(self) -> "DatabaseSettings":
        # An explicit Postgres DSN wins over the assembled one.
        if self.db_password and not self.dsn.startswith("postgresql"):
            dsn = (
                f"postgresql+asyncpg://{self.db_user}:{self.db_password}"
                f"@{self.db_host}:{self.db_port}/{self.db_name}"
            )
            if self.db_sslmode:
                dsn += f"?ssl={self.db_sslmode}"
            self.dsn = dsn
        return self


class WebhooksSettings(ScooterBaseSettings):
    """Settings specific to the webhooks service."""

    # Overrides the lib's "" default, which means "auto-linking off" to the broker but a misconfiguration here.
    agent_host_url: str = "http://agent-host.agent-sandbox.svc.cluster.local:8080"

    # Root log level, from LOG_LEVEL.
    log_level: str = "INFO"

    # Bring-your-own-Claude: the HS256 signing key for join tokens, shared with the agent-host; empty disables the bridge.
    remote_agent_join_secret: str = ""

    # Shared API key for internal relay endpoints.
    relay_api_key: str = ""

    # The /webhooks/test endpoint for e2e, off in prod.
    test_webhook_enabled: bool = False

    # Trigger pattern (text mention) and issue/PR label that spawn a conversation.
    mention_pattern: str = "@agent"
    label_trigger: str = "scooter"

    # Comment/review authors to drop (comma-separated), matched case-insensitively.
    ignore_usernames: str = ""

    # Deployment policy read through scooter_webhooks_lib.policy: drop a Bot-authored
    # comment or review that does not mention the agent, so its own comments do not come back as webhooks.
    ignore_bot_authors: bool = True

    # Pipe-separated repo descriptions.
    repo_descriptions: str = ""

    model_config = {"env_prefix": "", "case_sensitive": False}

    def get_repo_descriptions(self) -> dict[str, str]:
        if not self.repo_descriptions:
            return {}
        result = {}
        for entry in self.repo_descriptions.split("|"):
            entry = entry.strip()
            if "=" in entry:
                repo, desc = entry.split("=", 1)
                result[repo.strip()] = desc.strip()
        return result


settings = WebhooksSettings()
db_settings = DatabaseSettings()



def require_relay_key(
    credentials: HTTPAuthorizationCredentials | None = Security(_bearer_scheme),
) -> None:
    """FastAPI dependency that enforces Bearer token auth on internal endpoints."""
    key = settings.relay_api_key
    if not key:
        return
    if credentials is None or not hmac.compare_digest(credentials.credentials, key):
        raise HTTPException(status_code=401, detail="Invalid or missing relay API key")
