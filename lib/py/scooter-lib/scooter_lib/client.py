"""An async client for driving Scooter from a service or a system task.

Every call is authenticated with the pod's projected service-account token, re-read on
each request because the kubelet rotates it. The agent-host honours `owner` in a body
only alongside that token, so a caller holding it (the scheduler, and the tasks it runs)
can open a conversation as any user::

    async with ScooterClient.from_env() as scooter:
        conv = await scooter.spawn_conversation("alice", "Summarise my week", title="Digest")
        users = await scooter.list_users()
        due = await scooter.broker.get("/personalization/system/eligible")

`from_env` reads AGENT_HOST_URL, BROKER_URL, SCHEDULER_URL and SCOOTER_TOKEN_PATH, the
variables the scheduler sets for a system task.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, Generator

import httpx

from .logging_config import format_error, get_logger

logger = get_logger("scooter-lib", "client")

DEFAULT_TOKEN_PATH = "/var/run/secrets/agent-host/token"

# Statuses worth another attempt: the router's "no pod ready" 503 and other transient upstream failures.
_RETRY_STATUSES = frozenset({429, 502, 503, 504})
# A non-idempotent call retries only on refusals that happen before the request is handled.
_REFUSED_STATUSES = frozenset({429, 503})
# Errors raised before the request reached the server, so a retry cannot duplicate it.
_NOT_SENT = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout)


class SpawnError(RuntimeError):
    """The agent-host refused to create or prompt a conversation, or could not be reached.

    `conversation_id` is set when the create succeeded and only the prompt failed.
    """

    def __init__(self, message: str, conversation_id: str | None = None) -> None:
        super().__init__(message)
        self.conversation_id = conversation_id


class _TokenAuth(httpx.Auth):
    """Bearer auth from a token file, read per request; an unreadable file sends none."""

    def __init__(self, path: str) -> None:
        self.path = path

    def token(self) -> str | None:
        try:
            return Path(self.path).read_text().strip() or None
        except OSError:
            return None

    def auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response, None]:
        token = self.token()
        if token:
            request.headers["authorization"] = f"Bearer {token}"
        yield request


class ScooterClient:
    """The agent-host (conversations, users), the broker, and the scheduler, as one caller."""

    def __init__(
        self,
        *,
        agent_host_url: str,
        broker_url: str = "",
        scheduler_url: str = "",
        token_path: str = DEFAULT_TOKEN_PATH,
        timeout: httpx.Timeout | float = httpx.Timeout(120.0, connect=10.0),
        attempts: int = 3,
        backoff_seconds: float = 2.0,
        transport: httpx.AsyncBaseTransport | None = None,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self.agent_host_url = agent_host_url.rstrip("/")
        self.scheduler_url = scheduler_url.rstrip("/")
        self.auth = _TokenAuth(token_path)
        self.attempts = max(1, attempts)
        self.backoff_seconds = backoff_seconds
        # `transport` (httpx.MockTransport) and `http` are for tests; the caller owns an `http` it passes.
        self._owns_http = http is None
        self.http = http or httpx.AsyncClient(timeout=timeout, transport=transport)
        # Paths are relative to BROKER_URL: `await scooter.broker.get("/<contrib>/system/...")`.
        self.broker = httpx.AsyncClient(
            base_url=broker_url.rstrip("/") or "http://broker.invalid",
            auth=self.auth,
            timeout=timeout,
            transport=transport,
        )

    @classmethod
    def from_env(cls, **kw: Any) -> "ScooterClient":
        """Build from the environment a system task runs in."""
        env = os.environ
        return cls(
            agent_host_url=env.get("AGENT_HOST_URL", ""),
            broker_url=env.get("BROKER_URL", ""),
            scheduler_url=env.get("SCHEDULER_URL", ""),
            token_path=env.get("SCOOTER_TOKEN_PATH") or env.get("SA_TOKEN_PATH") or DEFAULT_TOKEN_PATH,
            **kw,
        )

    async def __aenter__(self) -> "ScooterClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self.broker.aclose()
        if self._owns_http:
            await self.http.aclose()

    def _agent_host(self, path: str) -> str:
        if not self.agent_host_url:
            raise SpawnError("AGENT_HOST_URL is not set")
        return f"{self.agent_host_url}{path}"

    async def _post(self, url: str, body: dict, *, idempotent: bool, what: str) -> httpx.Response:
        """POST with retry and exponential backoff; a non-idempotent call retries only when the request was never delivered or the router refused it."""
        retryable: tuple[type[BaseException], ...] = (httpx.TransportError,) if idempotent else _NOT_SENT
        statuses = _RETRY_STATUSES if idempotent else _REFUSED_STATUSES
        for attempt in range(1, self.attempts + 1):
            last = attempt == self.attempts
            try:
                resp = await self.http.post(url, json=body, auth=self.auth)
            except retryable as e:
                if last:
                    raise
                logger.warning(
                    f"{what} failed; retrying",
                    extra={"attempt": attempt, "max_attempts": self.attempts, "error": format_error(e)},
                )
            else:
                if resp.status_code not in statuses or last:
                    return resp
                logger.warning(
                    f"{what} returned {resp.status_code}; retrying",
                    extra={"attempt": attempt, "max_attempts": self.attempts, "status": resp.status_code},
                )
            await asyncio.sleep(self.backoff_seconds * 2 ** (attempt - 1))
        raise AssertionError("unreachable")

    async def spawn_conversation(
        self,
        owner: str | None,
        prompt: str,
        *,
        title: str | None = None,
        model: str | None = None,
        source: str = "system",
    ) -> str:
        """Create a conversation as `owner`, then prompt it; returns the server-assigned id.

        Raises SpawnError when either call is refused or fails, so a task fails visibly.
        """
        create: dict[str, Any] = {}
        if title:
            create["title"] = title
        if owner:
            # In the body rather than an identity header, since that header's name is deployment-configurable.
            create["owner"] = owner
        if model:
            create["model"] = model
        conversation_id: str | None = None
        try:
            # A retry after a lost reply can leave an empty conversation, which beats a skipped run.
            resp = await self._post(self._agent_host("/conversations"), create, idempotent=True, what="create")
            if resp.status_code >= 300:
                raise SpawnError(f"create failed: HTTP {resp.status_code}")
            conversation_id = resp.json().get("id")
            if not conversation_id:
                raise SpawnError("create returned no id")

            body: dict[str, Any] = {
                "threadId": conversation_id,
                "messages": [{"role": "user", "content": prompt}],
                # Not a human turn: the agent-host decorates it and the UI can hide it.
                "source": source,
            }
            if owner:
                body["owner"] = owner
            if model:
                body["model"] = model
            # Never re-sent once delivered, so it cannot run twice. /agui streams SSE, and only
            # the request being accepted matters here.
            resp = await self._post(self._agent_host("/agui"), body, idempotent=False, what="prompt")
            if resp.status_code >= 300:
                raise SpawnError(f"prompt failed: HTTP {resp.status_code}", conversation_id)
            return conversation_id
        except SpawnError as e:
            logger.error(
                "spawn failed",
                extra={"task_title": title, "conversation_id": conversation_id, "error": str(e)},
            )
            raise
        except httpx.HTTPError as e:
            logger.error(
                "spawn failed",
                extra={"task_title": title, "conversation_id": conversation_id, "error": format_error(e)},
            )
            stage = "prompt" if conversation_id else "create"
            raise SpawnError(
                f"{stage} failed: {type(e).__name__}: {e}".rstrip(": "), conversation_id
            ) from e

    async def list_users(self) -> list[dict[str, Any]]:
        """The users the agent-host knows (signed in, or mapped by a webhook)."""
        resp = await self.http.get(self._agent_host("/users"), auth=self.auth)
        resp.raise_for_status()
        return list(resp.json().get("users", []))

    async def report_spawn(self, run_id: str, conversation_id: str, owner: str | None) -> None:
        """Record a conversation on a scheduler run (POST /runs/{run_id}/conversations)."""
        if not self.scheduler_url:
            raise RuntimeError("SCHEDULER_URL is not set, so the spawn cannot be recorded")
        resp = await self.http.post(
            f"{self.scheduler_url}/runs/{run_id}/conversations",
            json={"conversation_id": conversation_id, "owner": owner},
            auth=self.auth,
        )
        resp.raise_for_status()
