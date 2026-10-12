"""Owner resolution for Slack: a user id to the email Scooter matches on, registered into `scooter_webhooks_lib.identity`."""

from __future__ import annotations

import logging

import httpx

from scooter_lib.logging_config import format_error, pseudonym
from scooter_webhooks_lib.identity import register_email_resolver

from .config import settings

logger = logging.getLogger(__name__)
_C = {"component": "contrib.slack.identity"}

_SLACK_API = "https://slack.com/api"


@register_email_resolver("slack")
async def slack_email(user_id: str) -> str | None:
    """The email for a Slack user id via users.info, which needs the users:read.email scope."""
    token = settings.slack_bot_token
    if not token or not user_id:
        return None
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{_SLACK_API}/users.info",
                headers={"Authorization": f"Bearer {token}"},
                params={"user": user_id},
            )
            data = resp.json()
        if not data.get("ok"):
            logger.info(
                "slack users.info not ok",
                extra={**_C, "provider": "slack", "external_user": pseudonym(user_id), "slack_error": data.get("error")},
            )
            return None
        return (data.get("user", {}).get("profile", {}) or {}).get("email") or None
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(
            "email lookup failed",
            extra={**_C, "provider": "slack", "external_user": pseudonym(user_id), "error": format_error(e)},
        )
        return None
