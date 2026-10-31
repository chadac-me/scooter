"""The forge policy hook: one check every path to a forge goes through before the broker injects a credential.

The paths are the git/`gh`/`glab` egress proxy, the `/{provider}/*` http-proxy and
the MCP tools' `ctx.upstream`. The default allows everything the credential allows;
a deployment narrows that by supplying its own `ForgePolicy` (`load_policy`).
"""

from __future__ import annotations

import importlib
import logging
from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

from ..types import Identity

logger = logging.getLogger(__name__)

# The channel a request arrived on.
Via = Literal["forge-proxy", "http-proxy", "mcp"]
# git smart-HTTP (and LFS), the forge API, or anything else on a forge host (sent without a credential).
Kind = Literal["git", "api", "web"]


@dataclass(frozen=True)
class RefUpdate:
    """One `old new ref` line of a git-receive-pack request."""

    old: str
    new: str
    ref: str

    @property
    def is_create(self) -> bool:
        return set(self.old) == {"0"}

    @property
    def is_delete(self) -> bool:
        return set(self.new) == {"0"}


@dataclass(frozen=True)
class GraphQLOperation:
    """One operation in a GraphQL document: its type, optional name and top-level field names."""

    type: Literal["query", "mutation", "subscription"]
    name: str | None
    fields: tuple[str, ...]


@dataclass(frozen=True)
class ForgeRequest:
    """What a policy sees about one request to a forge."""

    identity: Identity
    provider: str                 # "github" | "gitlab" | ...
    via: Via
    method: str
    host: str                     # the upstream host, e.g. "api.github.com"
    path: str                     # the URL path with a leading "/", query excluded, still percent-encoded
    kind: Kind
    # "owner/repo" (GitHub) or the full project path or numeric id (GitLab), when the path names one.
    repo: str | None = None
    # "git-upload-pack" (fetch) or "git-receive-pack" (push) for kind == "git".
    git_service: str | None = None
    # A push's ref updates; None when not a push, or when the request could not be parsed.
    ref_updates: tuple[RefUpdate, ...] | None = None
    # The operations of a GraphQL request body; None when not GraphQL or unparseable.
    graphql: tuple[GraphQLOperation, ...] | None = None
    query: str = ""
    # Each GraphQL operation's `variables` object; None when not GraphQL.
    graphql_variables: tuple[dict, ...] | None = None

    @property
    def is_push(self) -> bool:
        return self.git_service == "git-receive-pack"

    @property
    def is_mutation(self) -> bool:
        """A request that may change state: a non-GET/HEAD REST call, a push or a GraphQL mutation."""
        if self.graphql is not None:
            return any(op.type == "mutation" for op in self.graphql)
        if self.kind == "git":
            # info/refs?service=git-receive-pack is the push's read-only discovery step.
            return self.is_push and self.method.upper() == "POST"
        return self.method.upper() not in {"GET", "HEAD", "OPTIONS"}


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reason: str = ""

    @classmethod
    def allow(cls, reason: str = "") -> "Decision":
        return cls(True, reason)

    @classmethod
    def deny(cls, reason: str) -> "Decision":
        return cls(False, reason)


@runtime_checkable
class ForgePolicy(Protocol):
    """Decide whether one forge request may go out with the provider's credential."""

    async def check(self, request: ForgeRequest) -> Decision:
        ...


@dataclass
class AllowAll:
    """The default: everything the credential allows."""

    name: str = field(default="allow-all")

    async def check(self, request: ForgeRequest) -> Decision:
        return Decision.allow()


ALLOW_ALL = AllowAll()


def load_policy(spec: str) -> ForgePolicy:
    """Load a policy from a `module:attr` spec, calling `attr` when it is a factory; empty gives AllowAll."""
    spec = (spec or "").strip()
    if not spec:
        return ALLOW_ALL
    module_name, sep, attr = spec.partition(":")
    if not sep or not module_name or not attr:
        raise ValueError(f"forge policy {spec!r} must be 'module:attr'")
    obj = getattr(importlib.import_module(module_name), attr)
    # A class has a `check` attribute too, so the Protocol isinstance alone would accept an uninstantiated one.
    if isinstance(obj, type) or (callable(obj) and not hasattr(obj, "check")):
        obj = obj()
    if isinstance(obj, type) or not isinstance(obj, ForgePolicy):
        raise TypeError(f"forge policy {spec!r} has no async check(request)")
    logger.info("loaded forge policy", extra={"policy": spec})
    return obj


async def enforce(policy: ForgePolicy | None, request: ForgeRequest) -> Decision:
    """Run the policy, failing closed if it raises, and write the audit line every forge request gets."""
    policy = policy or ALLOW_ALL
    try:
        decision = await policy.check(request)
    except Exception as e:  # a buggy policy must not turn into an allow
        logger.exception("forge policy raised; denying", extra={"provider": request.provider})
        decision = Decision.deny(f"policy error: {type(e).__name__}")
    audit(request, decision)
    return decision


def audit(request: ForgeRequest, decision: Decision) -> None:
    extra: dict[str, object] = {
        "conversation_id": request.identity.conversation_id,
        "provider": request.provider,
        "via": request.via,
        "http_method": request.method,
        "host": request.host,
        "path": request.path,
        "kind": request.kind,
        "repo": request.repo,
        "allowed": decision.allowed,
        "reason": decision.reason,
    }
    if request.git_service:
        extra["git_service"] = request.git_service
    if request.ref_updates is not None:
        extra["ref_updates"] = [f"{u.old[:12]}..{u.new[:12]} {u.ref}" for u in request.ref_updates]
    if request.graphql is not None:
        extra["graphql"] = [f"{op.type} {op.name or ''} {','.join(op.fields)}".strip() for op in request.graphql]
    logger.info("forge request", extra=extra)


# The response header a denial carries, so an agent can tell policy from an auth failure.
DENY_HEADER = "X-Scooter-Policy"


def denial_message(decision: Decision) -> str:
    return f"denied by the Scooter forge policy: {decision.reason or 'not allowed'}"
