"""Spawn a Scooter conversation: ask the agent-host for a conversation id, then POST the task as the user message, with `owner` in the body of both calls and honored only when a valid SA token is presented."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

import httpx

from .config import settings
from .logging_config import format_error, get_logger

logger = get_logger("spawn")

# Statuses worth another attempt: the router's "no pod ready" 503 and other transient upstream failures.
_RETRY_STATUSES = frozenset({429, 502, 503, 504})
# A non-idempotent call retries only on refusals that happen before the request is handled.
_REFUSED_STATUSES = frozenset({429, 503})
# Errors raised before the request reached the server, so a retry cannot duplicate it.
_NOT_SENT = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout)


@dataclass(frozen=True)
class SpawnResult:
    conversation_id: str | None
    error: str | None = None


def _sa_token() -> str | None:
    """Read the projected SA token the agent-host verifies, or None when unreadable."""
    try:
        return Path(settings.sa_token_path).read_text().strip() or None
    except OSError:
        return None


def _timeout() -> httpx.Timeout:
    return httpx.Timeout(
        settings.spawn_read_timeout_seconds, connect=settings.spawn_connect_timeout_seconds
    )


async def _post(
    client: httpx.AsyncClient, url: str, body: dict, headers: dict, *, idempotent: bool, what: str
) -> httpx.Response:
    """POST with retry and exponential backoff; a non-idempotent call retries only when the request was never delivered or the router refused it."""
    attempts = max(1, settings.spawn_attempts)
    retryable: tuple[type[BaseException], ...] = (httpx.TransportError,) if idempotent else _NOT_SENT
    for attempt in range(1, attempts + 1):
        last = attempt == attempts
        try:
            resp = await client.post(url, json=body, headers=headers)
        except retryable as e:
            if last:
                raise
            logger.warning(
                f"{what} failed; retrying",
                extra={"attempt": attempt, "max_attempts": attempts, "error": format_error(e)},
            )
        else:
            statuses = _RETRY_STATUSES if idempotent else _REFUSED_STATUSES
            if resp.status_code not in statuses or last:
                return resp
            logger.warning(
                f"{what} returned {resp.status_code}; retrying",
                extra={"attempt": attempt, "max_attempts": attempts, "status": resp.status_code},
            )
        await asyncio.sleep(settings.spawn_backoff_seconds * 2 ** (attempt - 1))
    raise AssertionError("unreachable")


async def spawn(
    prompt: str, *, title: str | None, owner: str | None, client: httpx.AsyncClient | None = None
) -> SpawnResult:
    """Create a conversation, then prompt it, returning the server-assigned id or why it failed."""
    base = settings.agent_host_url.rstrip("/")
    headers = {"content-type": "application/json"}
    token = _sa_token()
    if token:
        headers["authorization"] = f"Bearer {token}"

    owns = client is None
    client = client or httpx.AsyncClient(timeout=_timeout())
    conversation_id: str | None = None
    try:
        # 1. Create. A retry after a lost reply can leave an empty conversation, which beats a skipped run.
        create_body: dict = {}
        if title:
            create_body["title"] = title
        if owner:
            # In the body rather than an identity header, since that header's name is deployment-configurable.
            create_body["owner"] = owner
        resp = await _post(
            client, f"{base}/conversations", create_body, headers, idempotent=True, what="create"
        )
        if resp.status_code >= 300:
            logger.error("create failed", extra={"status": resp.status_code, "task_title": title})
            return SpawnResult(None, f"create failed: HTTP {resp.status_code}")
        conversation_id = resp.json().get("id")
        if not conversation_id:
            logger.error("create returned no id", extra={"task_title": title})
            return SpawnResult(None, "create returned no id")

        # 2. Prompt the id the server gave us; never re-sent once delivered, so it cannot run twice.
        body = {
            "threadId": conversation_id,
            "messages": [{"role": "user", "content": prompt}],
            # A scheduled fire is a system message, which the agent-host decorates and the UI can hide.
            "source": "scheduler",
        }
        if owner:
            body["owner"] = owner
        # /agui streams SSE, and only the request being accepted matters here.
        resp = await _post(client, f"{base}/agui", body, headers, idempotent=False, what="prompt")
        if resp.status_code >= 300:
            logger.error(
                "spawn failed",
                extra={
                    "status": resp.status_code,
                    "task_title": title,
                    "conversation_id": conversation_id,
                },
            )
            return SpawnResult(None, f"prompt failed: HTTP {resp.status_code}")
        return SpawnResult(conversation_id)
    except httpx.HTTPError as e:
        logger.error(
            "spawn failed",
            extra={"task_title": title, "conversation_id": conversation_id, "error": format_error(e)},
        )
        stage = "prompt" if conversation_id else "create"
        return SpawnResult(None, f"{stage} failed: {type(e).__name__}: {e}".rstrip(": "))
    finally:
        if owns:
            await client.aclose()


async def spawn_conversation(
    prompt: str, *, title: str | None, owner: str | None, client: httpx.AsyncClient | None = None
) -> str | None:
    """Create a conversation, then prompt it, returning the server-assigned id or None."""
    return (await spawn(prompt, title=title, owner=owner, client=client)).conversation_id
