"""Who a sandbox's commits are authored by: the bot, or the user with the bot as co-author.

A forge contrib registers a `CommitIdentitySource`. Asked for `None` it names
the deployment's own bot; asked for a user it names that user's account, or
None when they have not linked one. `resolve` asks the sources in registration
order and takes the first answer.

An identity the user chose (the commits contrib, via `provide_chosen`) wins over
any forge's answer for that user.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Awaitable, Callable

from scooter_lib.logging_config import format_error

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Person:
    name: str
    email: str

    def ident(self) -> str:
        return f"{self.name} <{self.email}>"


@dataclass(frozen=True)
class CommitIdentity:
    """The author to commit as, and who to credit in a Co-authored-by trailer."""

    author: Person | None
    co_author: Person | None = None

    def payload(self) -> dict:
        return {
            "author": {"name": self.author.name, "email": self.author.email} if self.author else None,
            "co_author": self.co_author.ident() if self.co_author else None,
        }


# user=None asks for the bot; a user id asks for that user's linked account.
CommitIdentitySource = Callable[["str | None"], Awaitable["Person | None"]]

# Keyed by qualified name, so a factory built twice replaces its source.
_sources: dict[str, CommitIdentitySource] = {}


def register_commit_identity(source: CommitIdentitySource) -> CommitIdentitySource:
    """Add a source, replacing one registered under the same name; usable as a decorator."""
    _sources[f"{source.__module__}.{source.__qualname__}"] = source
    return source


ChosenLookup = Callable[[str], Awaitable["Person | None"]]

_chosen: ChosenLookup | None = None


def provide_chosen(lookup: ChosenLookup | None) -> None:
    """Install the lookup for a user's own chosen identity; None removes it."""
    global _chosen
    _chosen = lookup


async def _chosen_for(user: str) -> Person | None:
    if _chosen is None:
        return None
    try:
        return await _chosen(user)
    except Exception as e:  # noqa: BLE001 - fall back to the forge account
        logger.warning("chosen commit identity lookup failed", extra={"error": format_error(e)})
        return None


async def _first(user: str | None) -> Person | None:
    for source in list(_sources.values()):
        try:
            person = await source(user)
        except Exception as e:  # noqa: BLE001 - one forge outage must not stop the next source
            logger.warning(
                "commit identity source failed",
                extra={"source": getattr(source, "__qualname__", repr(source)), "error": format_error(e)},
            )
            continue
        if person is not None:
            return person
    return None


async def resolve(acting_user: str | None) -> CommitIdentity:
    """The user (bot as co-author) when acting for a user with an identity, else the bot alone."""
    bot = await _first(None)
    if acting_user is not None:
        user = await _chosen_for(acting_user) or await _first(acting_user)
        if user is not None:
            return CommitIdentity(author=user, co_author=bot)
    return CommitIdentity(author=bot)
