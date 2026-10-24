"""Scheduler service configuration: a SQLite dev default, or a Postgres DSN assembled from DB_PASSWORD and the DB_* components so the password can come from a secretKeyRef."""

import hmac

from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import model_validator
from pydantic_settings import BaseSettings

_bearer_scheme = HTTPBearer(auto_error=False)


class Settings(BaseSettings):
    # --- store ----------------------------------------------------------------
    dsn: str = "sqlite+aiosqlite:////tmp/scheduler.db"
    db_host: str = "local"
    db_port: int = 5432
    db_user: str = "scheduler"
    db_password: str = ""  # when set, a Postgres DSN is assembled
    db_name: str = "scheduler"
    db_sslmode: str = ""  # e.g. "require" for RDS; empty means no ssl param

    # --- spawn target -------------------------------------------------------
    # The agent-host a due task POSTs its prompt to.
    agent_host_url: str = "http://agent-host:8080"
    # The projected SA token to present so the agent-host honors `owner`.
    sa_token_path: str = "/var/run/secrets/agent-host/token"
    # Spawn HTTP timeouts; the prompt reply waits on a revive, which can take a minute.
    spawn_connect_timeout_seconds: float = 10.0
    spawn_read_timeout_seconds: float = 120.0
    # Attempts per spawn call, with exponential backoff from spawn_backoff_seconds.
    spawn_attempts: int = 3
    spawn_backoff_seconds: float = 2.0

    # --- system tasks ---------------------------------------------------------
    # The deployment's scooter.systemTasks, rendered by modules/scheduler.nix; absent = none.
    system_tasks_path: str = "/etc/scheduler/system-tasks/system-tasks.json"
    # At most this many system-task runs at once, across all tasks.
    system_task_concurrency: int = 4
    # After SIGTERM at a run's timeout, SIGKILL this long later.
    system_task_kill_grace_seconds: float = 30.0
    # A run's working directory is <task_tmp_dir>/task-<run id>.
    task_tmp_dir: str = "/tmp"
    # Passed to a run (the task contract): where it reaches the broker and this service.
    broker_url: str = ""
    broker_token_path: str = ""  # SCOOTER_BROKER_TOKEN_PATH: audience agent-broker
    scheduler_url: str = "http://agent-scheduler:8080"

    # --- API auth -----------------------------------------------------------
    # The key gating the /tasks API; empty disables auth.
    relay_key: str = ""

    # --- scheduler loop -----------------------------------------------------
    tick_seconds: int = 30  # how often the loop checks for due tasks

    # --- run history retention ----------------------------------------------
    # Delete task_runs older than this many days; 0 disables the sweep.
    run_retention_days: int = 90

    # --- observability ------------------------------------------------------
    # OpenTelemetry metrics via OTLP, configured by the standard OTEL_EXPORTER_OTLP_* env vars.
    otel_metrics_enabled: bool = False

    # --- logging ------------------------------------------------------------
    # Root log level, from LOG_LEVEL.
    log_level: str = "INFO"

    model_config = {"env_prefix": "", "case_sensitive": False}

    @model_validator(mode="after")
    def _assemble_dsn(self) -> "Settings":
        if self.db_password and not self.dsn.startswith("postgresql"):
            dsn = (
                f"postgresql+asyncpg://{self.db_user}:{self.db_password}"
                f"@{self.db_host}:{self.db_port}/{self.db_name}"
            )
            # asyncpg takes ssl via a query param.
            if self.db_sslmode:
                dsn += f"?ssl={self.db_sslmode}"
            self.dsn = dsn
        return self


settings = Settings()


def require_relay_key(
    creds: HTTPAuthorizationCredentials | None = Security(_bearer_scheme),
) -> None:
    """Gate the /tasks API on the relay key with a constant-time compare, or pass when no key is set."""
    if not settings.relay_key:
        return
    if creds is None or not hmac.compare_digest(creds.credentials, settings.relay_key):
        raise HTTPException(status_code=401, detail="invalid or missing API key")
