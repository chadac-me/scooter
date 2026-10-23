"""Spawn a Scooter conversation for a user task, through scooter_lib.client.

The shared client creates the conversation, then prompts the id the server assigned, with
`owner` in the body of both calls (honoured only alongside the SA token). User tasks keep
`source: "scheduler"` and send no model, so they run on the deployment's default.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx
from scooter_lib.client import ScooterClient, SpawnError

from .config import settings


@dataclass(frozen=True)
class SpawnResult:
    conversation_id: str | None
    error: str | None = None


def _timeout() -> httpx.Timeout:
    return httpx.Timeout(
        settings.spawn_read_timeout_seconds, connect=settings.spawn_connect_timeout_seconds
    )


async def spawn(
    prompt: str, *, title: str | None, owner: str | None, client: httpx.AsyncClient | None = None
) -> SpawnResult:
    """Create a conversation, then prompt it, returning the server-assigned id or why it failed."""
    async with ScooterClient(
        agent_host_url=settings.agent_host_url,
        token_path=settings.sa_token_path,
        timeout=_timeout(),
        attempts=settings.spawn_attempts,
        backoff_seconds=settings.spawn_backoff_seconds,
        http=client,
    ) as scooter:
        try:
            conversation_id = await scooter.spawn_conversation(owner, prompt, title=title, source="scheduler")
        except SpawnError as e:
            # The client already logged it with the conversation id.
            return SpawnResult(None, str(e))
    return SpawnResult(conversation_id)


async def spawn_conversation(
    prompt: str, *, title: str | None, owner: str | None, client: httpx.AsyncClient | None = None
) -> str | None:
    """Create a conversation, then prompt it, returning the server-assigned id or None."""
    return (await spawn(prompt, title=title, owner=owner, client=client)).conversation_id
