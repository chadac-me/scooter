"""The wake: broker -> agent-host POST /conversations/{id}/messages.

Registering an annotation IS the notification. Keeping them one step is the point:
a separate "now wake the agent" call is a second thing that can fail on its own,
and when it does, the human has commented and nothing happens — which is exactly
the failure the whole sync design is built to avoid.

Never raises. The annotation is already committed by the time this runs, so a
dropped wake delays the agent's turn; a raised one would fail a write that already
succeeded and send the viewer's outbox into retrying a stored record.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from .store import Annotation

logger = logging.getLogger(__name__)

# Retried for the same reason the aws approval notify is: the host's prompt is a
# find-or-start by thread id, so a duplicated delivery costs a turn, while a lost
# one costs the answer the human is waiting on.
_RETRY_STATUS = {408, 429}


def wake_message(annotation: Annotation) -> str:
    """What the agent reads when it wakes.

    It names the file, the line and the quoted text, because the agent wakes into a
    fresh turn with no memory of the document it wrote: "someone commented" would
    make it re-read the whole file to find out where.
    """
    what = "answered a question in" if annotation.kind == "answer" else "commented on"
    where = f"{annotation.path}:{annotation.anchor.line}"
    lines = [f"A reviewer {what} {where}."]
    if annotation.anchor.quote:
        lines.append(f"\nAnchored to: {annotation.anchor.quote!r}")
    if annotation.question_id:
        lines.append(f"Question: {annotation.question_id}")
    lines.append(f"\n{annotation.text}")
    lines.append(
        "\nOpen the files viewer to see the thread in context "
        f"(?path={annotation.path.lstrip('/')})."
    )
    return "\n".join(lines)


async def notify_host(
    annotation: Annotation,
    *,
    agent_host_url: str,
    attempts: int = 3,
    backoff: float = 0.5,
) -> bool:
    """Prompt the annotation's conversation, returning whether the host accepted it."""
    if not agent_host_url:
        return False

    url = f"{agent_host_url.rstrip('/')}/conversations/{annotation.conversation_id}/messages"
    payload = {"text": wake_message(annotation)}
    attempts = max(1, attempts)

    for attempt in range(1, attempts + 1):
        last = attempt == attempts
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(url, json=payload)
        except httpx.HTTPError as exc:
            if last:
                logger.error(
                    "annotation wake errored; giving up (the annotation is stored)",
                    extra={
                        "conversation_id": annotation.conversation_id,
                        "annotation_id": annotation.id,
                        "url": url,
                        "attempt": attempt,
                        "error": str(exc),
                    },
                )
                return False
            await asyncio.sleep(backoff * attempt)
            continue

        if resp.status_code < 300:
            return True

        retryable = resp.status_code >= 500 or resp.status_code in _RETRY_STATUS
        if not retryable or last:
            logger.error(
                "annotation wake refused (the annotation is stored)",
                extra={
                    "conversation_id": annotation.conversation_id,
                    "annotation_id": annotation.id,
                    "url": url,
                    "status": resp.status_code,
                    "attempt": attempt,
                },
            )
            return False
        await asyncio.sleep(backoff * attempt)

    return False
