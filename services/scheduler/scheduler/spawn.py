"""Spawn a Scooter conversation: ask the agent-host for a conversation id, then POST the task as the user message, with `owner` in the body of both calls and honored only when a valid SA token is presented."""

from __future__ import annotations

from pathlib import Path

import httpx

from .config import settings
from .logging_config import format_error, get_logger

logger = get_logger("spawn")


def _sa_token() -> str | None:
    """Read the projected SA token the agent-host verifies, or None when unreadable."""
    try:
        return Path(settings.sa_token_path).read_text().strip() or None
    except OSError:
        return None


async def spawn_conversation(
    prompt: str, *, title: str | None, owner: str | None, client: httpx.AsyncClient | None = None
) -> str | None:
    """Create a conversation, then prompt it, returning the server-assigned id or None."""
    base = settings.agent_host_url.rstrip("/")
    headers = {"content-type": "application/json"}
    token = _sa_token()
    if token:
        headers["authorization"] = f"Bearer {token}"

    owns = client is None
    client = client or httpx.AsyncClient(timeout=30.0)
    try:
        # 1. Create.
        create_body: dict = {}
        if title:
            create_body["title"] = title
        if owner:
            # In the body rather than an identity header, since that header's name is deployment-configurable.
            create_body["owner"] = owner
        resp = await client.post(f"{base}/conversations", json=create_body, headers=headers)
        if resp.status_code >= 300:
            logger.error(
                "create failed", extra={"status": resp.status_code, "task_title": title}
            )
            return None
        conversation_id = resp.json().get("id")
        if not conversation_id:
            logger.error("create returned no id", extra={"task_title": title})
            return None

        # 2. Prompt the id the server gave us.
        body = {
            "threadId": conversation_id,
            "messages": [{"role": "user", "content": prompt}],
            # A scheduled fire is a system message, which the agent-host decorates and the UI can hide.
            "source": "scheduler",
        }
        if owner:
            body["owner"] = owner
        # /agui streams SSE, and only the request being accepted matters here.
        resp = await client.post(f"{base}/agui", json=body, headers=headers)
        if resp.status_code >= 300:
            logger.error(
                "spawn failed",
                extra={
                    "status": resp.status_code,
                    "task_title": title,
                    "conversation_id": conversation_id,
                },
            )
            return None
        return conversation_id
    except httpx.HTTPError as e:
        logger.error("spawn failed", extra={"task_title": title, "error": format_error(e)})
        return None
    finally:
        if owns:
            await client.aclose()
