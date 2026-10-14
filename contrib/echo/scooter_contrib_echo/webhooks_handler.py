"""Echo webhooks handler: the webhooks half of the reference contrib.

Registered via the ``scooter_webhooks.handlers`` entry point and build-depending
only on ``scooter_webhooks_lib``. It mounts ``POST /webhooks/echo``, which echoes
its payload back and spawns no conversation, so it is inert outside a test image.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from scooter_webhooks_lib.registry import WebhookHandler, register_webhook

HANDLER_NAME = "echo"

router = APIRouter()


class EchoEvent(BaseModel):
    message: str = ""


@router.post("/webhooks/echo")
async def echo_webhook(event: EchoEvent) -> dict:
    return {"handler": HANDLER_NAME, "echo": event.message}


@register_webhook
def echo_contrib() -> WebhookHandler:
    """Build the echo handler, registered ``enabled`` like every handler that self-gates in-route."""
    return WebhookHandler(name=HANDLER_NAME, router=router)
