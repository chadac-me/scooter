"""Resolving a conversation's attached resource from its links.

The answer decides both whether a reply tool is offered (the attachment gate) and
what it acts on. Two rules: the oldest link wins, so the resource the conversation
was started from beats one the agent created later; and a target is taken whole
from one link or not at all, never mixed across links. Each provider supplies its
own `resolve`, because only it knows its id grammar.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any, TypeVar

T = TypeVar("T")

# A link row as the agent-host's GET /conversations/{id}/links returns it.
Link = dict[str, Any]


def links_for(links: Sequence[Link], source: str) -> list[Link]:
    """This source's links, in the order given (oldest first)."""
    return [link for link in links if link.get("source") == source]


def ref_of(link: Link) -> dict[str, Any]:
    """A link's structured `ref`, or an empty mapping."""
    ref = link.get("ref")
    return ref if isinstance(ref, dict) else {}


def first_target(
    links: Sequence[Link],
    source: str,
    resolve: Callable[[Link], T | None],
) -> T | None:
    """The first link of `source` for which `resolve` yields a complete target."""
    for link in links_for(links, source):
        target = resolve(link)
        if target is not None:
            return target
    return None


def resource_type_is(resource_type: str, *, truthy: Sequence[str], falsy: Sequence[str]) -> bool | None:
    """Classify a link's `resourceType` against two spelling sets, returning None when it matches neither."""
    lowered = (resource_type or "").strip().lower()
    if lowered in truthy:
        return True
    if lowered in falsy:
        return False
    return None
