"""Owner resolution for GitLab: a username to the email Scooter matches on, registered into `scooter_webhooks_lib.identity`."""

from __future__ import annotations

import logging

import httpx

from scooter_lib.logging_config import format_error, pseudonym
from scooter_webhooks_lib.identity import register_email_resolver

from .config import settings

logger = logging.getLogger(__name__)
_C = {"component": "contrib.gitlab.identity"}

_GITLAB_API = "https://gitlab.com/api/v4"


@register_email_resolver("gitlab")
async def gitlab_email(username: str) -> str | None:
    """The email for a GitLab username (GET /users?username=), which needs a token scoped to see it."""
    token = settings.gitlab_token
    if not token or not username:
        return None
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{_GITLAB_API}/users",
                headers={"PRIVATE-TOKEN": token},
                params={"username": username},
            )
            if resp.status_code != 200:
                return None
            users = resp.json()
        if not isinstance(users, list) or not users:
            return None
        return users[0].get("email") or None
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(
            "email lookup failed",
            extra={**_C, "provider": "gitlab", "external_user": pseudonym(username), "error": format_error(e)},
        )
        return None
