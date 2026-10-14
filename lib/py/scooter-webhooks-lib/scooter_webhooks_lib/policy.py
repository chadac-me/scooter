"""Trigger policy: the deployment-wide rules every handler applies identically.

What spawns a conversation (a mention, a label) and whose events to drop (ignored
users, bots, our own chatter). The module is given its settings at startup.
"""

from __future__ import annotations

from typing import Protocol


class TriggerPolicyConfig(Protocol):
    """What the policy needs from whatever settings object the app hands it."""

    mention_pattern: str
    label_trigger: str
    ignore_usernames: str
    ignore_bot_authors: bool

    def get_repo_descriptions(self) -> dict[str, str]: ...


_config: TriggerPolicyConfig | None = None

# Parsed per distinct value, so a settings change at runtime is honored without re-splitting on every event.
_ignored_cache: tuple[str, frozenset[str]] = ("", frozenset())


def init(config: TriggerPolicyConfig) -> None:
    """Bind the trigger policy once at service startup."""
    global _config
    _config = config


def _cfg() -> TriggerPolicyConfig:
    if _config is None:
        raise RuntimeError("scooter_webhooks_lib.policy.init(config) was never called")
    return _config


def mentions_agent(text: str) -> bool:
    """Whether this text mentions the agent, case-insensitively."""
    return _cfg().mention_pattern.lower() in (text or "").lower()


def mention_pattern() -> str:
    """The raw trigger text, for handlers that rewrite it rather than test it."""
    return _cfg().mention_pattern


def strip_mention(text: str) -> str:
    """The message with the mention removed."""
    return (text or "").replace(_cfg().mention_pattern, "").strip()


def is_trigger_label(label: str) -> bool:
    """Whether this is the label whose addition spawns a conversation."""
    return (label or "").lower() == _cfg().label_trigger.lower()


def is_ignored_user(username: str) -> bool:
    """Whether this author is on the deployment's drop list, case-insensitively."""
    global _ignored_cache
    raw = _cfg().ignore_usernames or ""
    if _ignored_cache[0] != raw:
        _ignored_cache = (raw, frozenset(u.strip().lower() for u in raw.split(",") if u.strip()))
    return bool(username) and username.lower() in _ignored_cache[1]


def ignore_bot_authors() -> bool:
    """Whether to drop Bot-authored events that do not mention the agent, the fallback when its own `<slug>[bot]` login cannot be resolved."""
    return _cfg().ignore_bot_authors


def repo_description(repo: str) -> str | None:
    """The configured description for a repo, if any."""
    return _cfg().get_repo_descriptions().get(repo) or None


def repo_context(repo: str) -> str:
    """The repo description as a prompt fragment, or empty."""
    desc = repo_description(repo)
    return f"\nRepo description: {desc}\n" if desc else ""


def is_own_ack(body: str) -> bool:
    """Whether this comment is one of our own acks, including the legacy "OpenHands" markers."""
    return (
        body.startswith("Scooter is on it")
        or body.startswith("OpenHands is working on this.")
        or "OpenHands status:" in body
    )
