"""Spawn a Scooter conversation for a user task, or prompt its target one, through scooter_lib.client.

The shared client creates the conversation, then prompts the id the server assigned, with
`owner` in the body of both calls (honoured only alongside the SA token). User tasks keep
`source: "scheduler"` and send no model, so they run on the deployment's default.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx
from scooter_lib.client import ConversationGone, ScooterClient, SpawnError

from .config import settings


@dataclass(frozen=True)
class SpawnResult:
    conversation_id: str | None
    error: str | None = None
    # Target conversation is gone, so the task should stop.
    gone: bool = False


def _client(client: httpx.AsyncClient | None) -> ScooterClient:
    return ScooterClient(
        agent_host_url=settings.agent_host_url,
        token_path=settings.sa_token_path,
        timeout=_timeout(),
        attempts=settings.spawn_attempts,
        backoff_seconds=settings.spawn_backoff_seconds,
        http=client,
    )


def _timeout() -> httpx.Timeout:
    return httpx.Timeout(
        settings.spawn_read_timeout_seconds, connect=settings.spawn_connect_timeout_seconds
    )


async def spawn(
    prompt: str, *, title: str | None, owner: str | None, client: httpx.AsyncClient | None = None
) -> SpawnResult:
    """Create a conversation, then prompt it, returning the server-assigned id or why it failed."""
    async with _client(client) as scooter:
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


async def deliver(
    conversation_id: str, prompt: str, *, owner: str | None, client: httpx.AsyncClient | None = None
) -> SpawnResult:
    """Prompt an existing conversation, returning its id or why delivery failed."""
    async with _client(client) as scooter:
        try:
            await scooter.prompt_conversation(conversation_id, prompt, owner=owner, source="scheduler")
        except ConversationGone as e:
            return SpawnResult(None, f"conversation {conversation_id} no longer exists: {e}", gone=True)
        except SpawnError as e:
            return SpawnResult(None, str(e))
    return SpawnResult(conversation_id)
