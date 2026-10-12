"""The controller's write path to `agent_host.conversations`.

The controller mirrors the phases it decides (Failed, Pending, the Suspended drift repair) and
its placements onto the row. Every method is best-effort: it swallows its errors and returns a
bool, because the controller must keep reconciling when Postgres is unreachable and the CR
remains authoritative.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_C = {"component": "rows"}

# Every write role is pinned read-only at the role level (modules/postgres.nix), and a writer
# overrides that on its own connection.
CONNECT_OPTIONS = "-c default_transaction_read_only=off"

# Conversations per sync statement, keeping bind parameters under Postgres' 65535 limit.
_SYNC_CHUNK = 500


def dsn_from_env() -> str | None:
    """Build the agent_host DSN from the AGENT_HOST_DB_* env, or None when no database is configured."""
    if dsn := os.environ.get("AGENT_HOST_DB_DSN"):
        return dsn
    host = os.environ.get("AGENT_HOST_DB_HOST")
    if not host:
        return None
    parts = [
        f"host={host}",
        f"port={os.environ.get('AGENT_HOST_DB_PORT', '5432')}",
        f"dbname={os.environ.get('AGENT_HOST_DB_NAME', 'agent_host')}",
        f"user={os.environ.get('AGENT_HOST_DB_USER', 'conversation_controller')}",
    ]
    if password := os.environ.get("AGENT_HOST_DB_PASSWORD"):
        parts.append(f"password={password}")
    if sslmode := os.environ.get("AGENT_HOST_DB_SSLMODE"):
        parts.append(f"sslmode={sslmode}")
    return " ".join(parts)


class ConversationRows:
    """One lazily-opened connection, reopened on the next call after any failure."""

    def __init__(self, dsn: str, connect=None) -> None:
        self._dsn = dsn
        self._conn = None
        self._connect_fn = connect or self._psycopg_connect

    @staticmethod
    def _psycopg_connect(dsn: str):
        import psycopg  # imported here so the module is importable without the driver installed

        # Each write is one statement that must land immediately.
        return psycopg.connect(dsn, autocommit=True, connect_timeout=5, options=CONNECT_OPTIONS)

    def _cursor(self):
        if self._conn is None:
            self._conn = self._connect_fn(self._dsn)
        return self._conn.cursor()

    def _drop(self) -> None:
        """Discard a connection that errored, so the next call reconnects."""
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass

    def set_phase(self, conversation_id: str, phase: str) -> bool:
        """Mirror a phase onto the row, returning True when a row was updated (a miss is not an error)."""
        try:
            with self._cursor() as cur:
                cur.execute(
                    "UPDATE conversations SET phase = %s WHERE id = %s",
                    (phase, conversation_id),
                )
                return cur.rowcount > 0
        except Exception as err:  # noqa: BLE001
            self._drop()
            logger.warning(
                "conversations row phase write failed",
                extra={**_C, "conversation_id": conversation_id, "phase": phase, "error": str(err)},
            )
            return False

    def sync_phases(self, phases: list[tuple[str, str]]) -> int:
        """Converge the phase column on every listed CR in chunked statements and return the rows changed, so a dropped or never-made write self-heals."""
        if not phases:
            return 0
        changed = 0
        for i in range(0, len(phases), _SYNC_CHUNK):
            chunk = phases[i : i + _SYNC_CHUNK]
            values = ",".join(["(%s::text, %s::text)"] * len(chunk))
            params: list[str] = []
            for conversation_id, phase in chunk:
                params += [conversation_id, phase]
            try:
                with self._cursor() as cur:
                    cur.execute(
                        "UPDATE conversations AS c SET phase = v.phase "
                        f"FROM (VALUES {values}) AS v(id, phase) "
                        "WHERE c.id = v.id AND c.phase IS DISTINCT FROM v.phase",
                        params,
                    )
                    changed += max(cur.rowcount, 0)
            except Exception as err:  # noqa: BLE001
                self._drop()
                logger.warning(
                    "conversations row phase sync failed",
                    extra={**_C, "conversations": len(chunk), "error": str(err)},
                )
                # The remaining chunks would each pay a fresh connect; the next tick retries all.
                break
        return changed

    def set_assignment(self, conversation_id: str, host_pod: str, generation: int) -> bool:
        """Claim a conversation for a pod at an epoch, returning True when the claim won; the generation condition is what keeps ownership monotonic against a stale controller."""
        try:
            with self._cursor() as cur:
                cur.execute(
                    "UPDATE conversations SET host_pod = %s, host_generation = %s "
                    "WHERE id = %s AND %s > host_generation",
                    (host_pod, generation, conversation_id, generation),
                )
                return cur.rowcount > 0
        except Exception as err:  # noqa: BLE001
            self._drop()
            logger.warning(
                "conversations row assignment write failed",
                extra={
                    **_C,
                    "conversation_id": conversation_id,
                    "host_pod": host_pod,
                    "generation": generation,
                    "error": str(err),
                },
            )
            return False

    def release_assignment(self, conversation_id: str, generation: int) -> bool:
        """Clear host_pod at the current epoch, leaving host_generation as the high-water mark so a stale controller cannot detach a newer assignment."""
        try:
            with self._cursor() as cur:
                cur.execute(
                    "UPDATE conversations SET host_pod = NULL "
                    "WHERE id = %s AND %s >= host_generation AND host_pod IS NOT NULL",
                    (conversation_id, generation),
                )
                return cur.rowcount > 0
        except Exception as err:  # noqa: BLE001
            self._drop()
            logger.warning(
                "conversations row release failed",
                extra={**_C, "conversation_id": conversation_id, "error": str(err)},
            )
            return False

    def sync_assignments(self, assignments: list[tuple[str, str | None, int]]) -> int:
        """Converge host_pod/host_generation on every listed CR at its current epoch and return the rows changed, since appends fence on the row and an unwritten row blocks them."""
        if not assignments:
            return 0
        changed = 0
        for i in range(0, len(assignments), _SYNC_CHUNK):
            chunk = assignments[i : i + _SYNC_CHUNK]
            values = ",".join(["(%s::text, %s::text, %s::bigint)"] * len(chunk))
            params: list[object] = []
            for conversation_id, host_pod, generation in chunk:
                params += [conversation_id, host_pod, generation]
            try:
                with self._cursor() as cur:
                    cur.execute(
                        "UPDATE conversations AS c "
                        "SET host_pod = v.host_pod, host_generation = v.gen "
                        f"FROM (VALUES {values}) AS v(id, host_pod, gen) "
                        "WHERE c.id = v.id AND v.gen >= c.host_generation "
                        "AND (c.host_pod IS DISTINCT FROM v.host_pod OR c.host_generation <> v.gen)",
                        params,
                    )
                    changed += max(cur.rowcount, 0)
            except Exception as err:  # noqa: BLE001
                self._drop()
                logger.warning(
                    "conversations row assignment sync failed",

                    extra={**_C, "conversations": len(chunk), "error": str(err)},
                )
                break
        return changed

    def close(self) -> None:
        self._drop()


def from_env(connect=None) -> ConversationRows | None:
    """Build a writer from the environment, or None when no database is configured."""
    dsn = dsn_from_env()
    if not dsn:
        logger.info("no agent_host DSN configured — controller will not mirror phases to the row", extra=_C)
        return None
    return ConversationRows(dsn, connect=connect)
