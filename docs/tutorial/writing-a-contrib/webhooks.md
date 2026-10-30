# The webhook handler

A webhook handler lets events in the provider start and steer conversations: a mention
in an Acme comment opens one, and later comments on the same issue are forwarded to it.
It runs in the **webhooks service**, a separate image from the broker, and only that
image loads `webhooks_handler.py`. See [Configuring webhooks](../webhooks.md) for how
operators set the shipped handlers up.

## The shape of a handler

A handler is a FastAPI router plus a registered factory:

```python
# contrib/acme/scooter_contrib_acme/webhooks_handler.py
"""Acme webhook handler: a mention in an issue comment starts or steers a conversation."""

from __future__ import annotations

import asyncio
import hmac
import logging

from fastapi import APIRouter, Header, HTTPException, Request

from scooter_webhooks_lib import policy
from scooter_webhooks_lib import store as db
from scooter_webhooks_lib.agent_host_client import (
    SendOutcome, conversation_url, create_conversation, deliver_message, push_link,
)
from scooter_webhooks_lib.identity import resolve_owner
from scooter_webhooks_lib.registry import WebhookHandler, register_webhook
from scooter_webhooks_lib.store import PENDING_CONVERSATION_ID, is_pending

from .config import AcmeSettings

logger = logging.getLogger(__name__)
settings = AcmeSettings()
router = APIRouter()


def _verify(body: bytes, token: str) -> bool:
    secret = settings.acme_webhook_secret
    return bool(secret) and hmac.compare_digest(token, secret)


@router.post("/webhooks/acme")
async def handle_acme(request: Request, x_acme_token: str = Header("")):
    if not settings.acme_enabled:
        return {"status": "disabled"}
    if not _verify(await request.body(), x_acme_token):
        raise HTTPException(status_code=401, detail="Invalid webhook token")

    event = await request.json()
    if event.get("type") == "comment.created":
        await _handle_comment(event)
    # Answer fast: providers retry (and eventually disable) slow webhooks.
    return {"status": "ok"}
```

The factory registers the router. Its function name must be the contrib's
name, which is what the generated entry point calls:

```python
@register_webhook
def acme() -> WebhookHandler:
    return WebhookHandler(name="acme", router=router)
```

**Verify every delivery.** The webhooks host is deliberately unauthenticated, so the
signature check is the only thing between the internet and your handler. Use
`hmac.compare_digest`, and refuse when the secret is unset. Several shipped handlers
accept unsigned requests when their secret is empty, for local testing. Don't copy that.

## Starting or steering a conversation

The usual flow for a comment:

1. **Ignore yourself and filtered users.** Use `policy.is_ignored_user(name)`, and
   recognize the agent's own comments, or it will reply to itself forever.
2. **Look up the conversation** already mapped to this resource with
   `db.lookup_conversation(source, resource_type, resource_id)`.
3. **If there is one, forward the event** with `deliver_message`. If it isn't found any
   more, fall through and start a new one.
4. **Otherwise, if the comment mentions the agent** (`policy.mentions_agent(text)`),
   start a conversation.

```python
async def _handle_comment(event: dict) -> None:
    comment, issue = event["comment"], event["issue"]
    author, text, key = comment["author"]["username"], comment["body"], issue["key"]

    if author == "scooter-bot" or policy.is_ignored_user(author):
        return

    existing = await db.lookup_conversation("acme", "issue", key)
    if is_pending(existing):
        return  # a conversation for this issue is being created right now
    if existing:
        # Interrupts the agent at its next tool-call boundary, so the message
        # lands in order with the thread rather than after the run ends.
        outcome = await deliver_message(
            existing, f"{author} commented on {key}:\n\n{text}", source="acme",
        )
        if outcome is not SendOutcome.NOT_FOUND:
            return

    if not policy.mentions_agent(text):
        return

    # Claim the issue first, so a second delivery can't start a duplicate.
    await db.store_conversation("acme", "issue", key, PENDING_CONVERSATION_ID)
    asyncio.create_task(_start(key, issue["title"], author, policy.strip_mention(text)))
```

`create_conversation` returns only after the agent's whole first turn, so **always run it
in the background**. Its `on_created` callback runs as soon as the conversation exists,
before the agent starts. Use it to record the mapping, attach the issue, and tell the
person where to follow along:

```python
async def _start(key: str, title: str, author: str, request: str) -> None:
    async def _register(conversation_id: str) -> None:
        await db.store_conversation("acme", "issue", key, conversation_id)
        await push_link(
            conversation_id, source="acme", resource_type="issue",
            title=key, ref={"issue": key},   # what acme_comment replies to
        )
        logger.info("started %s for %s", conversation_url(conversation_id), key)

    result = await create_conversation(
        f"{author} asked you on Acme issue {key} ({title}):\n\n{request}\n\n"
        f"Reply on the issue with the `acme_comment` tool.",
        title=f"{key}: {title}",
        on_created=_register,
        owner=await resolve_owner("acme", author),
        source="acme",
    )
    if result is None:
        await db.clear_conversation("acme", "issue", key)  # release the claim
```

This sketch leaves out what the real handlers also do: queue messages that arrive while
a conversation is pending, post an acknowledgement on the issue, and retry. Read
`contrib/gitlab/scooter_contrib_gitlab/webhooks_handler.py` for the complete version.

## Owners

`resolve_owner(provider, external_id)` attributes the conversation to the Scooter user
with the same email address. The webhooks library can't know how to find an Acme user's
email, so the contrib registers a resolver:

```python
# contrib/acme/scooter_contrib_acme/identity.py
from scooter_webhooks_lib.identity import register_email_resolver


@register_email_resolver("acme")
async def acme_email(username: str) -> str | None:
    """Look the user up in the Acme API. None leaves the conversation unowned."""
    ...
```

Import it from `webhooks_handler.py` for its side effect, as the shipped handlers do:

```python
from . import identity  # noqa: F401
```

## Configuration

The handler reads `ACME_ENABLED` and `ACME_WEBHOOK_SECRET`. The webhooks service gets its
provider settings from the Secret named by `scooter.webhooks.secretName`, so document both
keys for operators. See [the deployment half](deployment.md#webhooks-settings).

Next: [the sandbox module](sandbox.md).
