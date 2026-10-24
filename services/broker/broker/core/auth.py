"""Caller authentication: validate a projected SA token via K8s TokenReview and parse the
SA username `system:serviceaccount:{ns}:sandbox-{conversationId}` into an Identity."""

from __future__ import annotations

import logging
import re

from fastapi import HTTPException, Request
from kubernetes import client, config

from scooter_broker_lib.types import Identity
from ..config import settings
from .conv_token import CONV_TOKEN_HEADER, ConvTokenError, verify_conv_token

logger = logging.getLogger(__name__)

_SA_PATTERN = re.compile(r"^system:serviceaccount:([^:]+):sandbox-(.+)$")

_authn_api: client.AuthenticationV1Api | None = None


def _api() -> client.AuthenticationV1Api:
    global _authn_api
    if _authn_api is None:
        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config()
        _authn_api = client.AuthenticationV1Api()
    return _authn_api


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    return header[len("bearer "):].strip()


async def _review(token: str) -> str:
    """Validate a projected SA token via TokenReview, pinned to the broker audience, and return its SA username."""
    review = client.V1TokenReview(
        spec=client.V1TokenReviewSpec(
            token=token,
            audiences=[settings.token_audience],
        )
    )
    try:
        result = _api().create_token_review(review)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=502, detail="token review failed") from exc

    status = result.status
    if not status or not status.authenticated:
        raise HTTPException(status_code=401, detail="token not authenticated")

    return status.user.username if status.user else ""


RELAYED_USER_HEADER = "x-scooter-user"


def _csv(raw: str) -> set[str]:
    return {s.strip() for s in raw.split(",") if s.strip()}


def _relayed_user(request: Request, username: str) -> str | None:
    """The user named in X-Scooter-User, trusted only from a user-relay account; None from anyone else."""
    if username not in _csv(settings.user_relay_service_accounts):
        return None
    user = request.headers.get(RELAYED_USER_HEADER, "").strip()
    return user or None


async def authenticate(request: Request) -> Identity:
    """FastAPI dependency: validate the Bearer SA token and return Identity."""
    token = _bearer(request)
    username = await _review(token)

    relayed_user = _relayed_user(request, username)

    # Approver SAs are not sandboxes: they have no conversation_id but may approve.
    approvers = _csv(settings.approver_service_accounts)
    if username in approvers:
        return Identity(conversation_id="", namespace=settings.sandbox_namespace,
                        service_account=username, is_approver=True,
                        relayed_user=relayed_user)

    if username in _csv(settings.system_task_service_accounts):
        # The scheduler, running a system task: no conversation and no user, and never an approver.
        return Identity(conversation_id="", namespace=settings.sandbox_namespace,
                        service_account=username, is_system_task=True)

    if username in _csv(settings.user_relay_service_accounts):
        # A relay account that is not also an approver is still not a sandbox; without
        # the header it names nobody, and user routes refuse it.
        return Identity(conversation_id="", namespace=settings.sandbox_namespace,
                        service_account=username, relayed_user=relayed_user)

    m = _SA_PATTERN.match(username or "")
    if not m:
        raise HTTPException(status_code=403, detail=f"not a sandbox SA: {username}")

    namespace, conversation_id = m.group(1), m.group(2)
    if namespace != settings.sandbox_namespace:
        raise HTTPException(status_code=403, detail="wrong namespace")

    return Identity(
        conversation_id=conversation_id,
        namespace=namespace,
        service_account=username,
    )


# ---------------------------------------------------------------------------
# MCP: the two-token path
# ---------------------------------------------------------------------------
#
# An SA token identifies the caller, and for the control plane that is one agent-host
# serving every conversation, so the MCP endpoint derives the conversation from the
# credential cryptographically bound to it: a control-plane caller presents its SA token
# (TokenReview, allowlisted in mcp_caller_service_accounts) plus a signed conversation
# token in X-Scooter-Conversation, while a sandbox's own SA name already binds it to
# exactly one conversation. A control-plane caller without a conversation token is
# rejected rather than defaulted.


def _mcp_callers() -> set[str]:
    """SA usernames allowed to act for a conversation via a conversation token, a separate authorization from `approver_service_accounts`."""
    return {s.strip() for s in settings.mcp_caller_service_accounts.split(",") if s.strip()}


async def authenticate_mcp(request: Request) -> Identity:
    """FastAPI dependency for the MCP endpoint, returning an Identity whose conversation_id is bound to the presented credentials."""
    token = _bearer(request)
    username = await _review(token)

    # Control plane: an allowlisted caller acting for the conversation its token names.
    if username in _mcp_callers():
        conv_token = request.headers.get(CONV_TOKEN_HEADER, "").strip()
        if not conv_token:
            raise HTTPException(
                status_code=403,
                detail=(
                    "a control-plane caller must present a conversation token in "
                    f"{CONV_TOKEN_HEADER}"
                ),
            )
        try:
            verified = verify_conv_token(conv_token, settings.conv_token_secret)
        except ConvTokenError as exc:
            # The reason goes to the log only, never the 403 body.
            logger.warning(
                "rejected an MCP conversation token",
                extra={"service_account": username, "reason": str(exc)},
            )
            raise HTTPException(status_code=403, detail="invalid conversation token") from exc
        return Identity(
            conversation_id=verified.conversation_id,
            namespace=settings.sandbox_namespace,
            service_account=username,
            owner=verified.owner,
        )

    # The sandbox itself: the SA name is the binding.
    m = _SA_PATTERN.match(username or "")
    if not m:
        raise HTTPException(status_code=403, detail=f"not permitted on the MCP endpoint: {username}")
    namespace, conversation_id = m.group(1), m.group(2)
    if namespace != settings.sandbox_namespace:
        raise HTTPException(status_code=403, detail="wrong namespace")

    # A conversation token naming a different conversation than the SA is refused.
    conv_token = request.headers.get(CONV_TOKEN_HEADER, "").strip()
    if conv_token:
        try:
            verified = verify_conv_token(conv_token, settings.conv_token_secret)
        except ConvTokenError as exc:
            raise HTTPException(status_code=403, detail="invalid conversation token") from exc
        if verified.conversation_id != conversation_id:
            raise HTTPException(
                status_code=403,
                detail="conversation token does not match the calling sandbox",
            )

    return Identity(
        conversation_id=conversation_id,
        namespace=namespace,
        service_account=username,
    )
