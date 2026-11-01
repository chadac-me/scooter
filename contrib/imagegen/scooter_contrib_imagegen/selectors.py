"""Pluggable backend selection: when the agent does not name a backend, the broker
orders the enabled candidates by calling a selector — the entry point named by
`contribs.imagegen.selector` (default "priority") in the `scooter_imagegen.selectors`
group. The broker then tries the returned order, falling through to the next one on
a backend error (handled by the caller, mcp_tools.py — a selector only orders).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Sequence

from .manifest import GenerateRequest


@dataclass(frozen=True)
class BackendCandidate:
    """One enabled backend eligible for this request, as the operator configured it."""

    name: str
    priority: int
    daily_limit: int | None


@dataclass(frozen=True)
class Usage:
    """This user's counts so far today, read from the broker's own store."""

    total: int
    total_limit: int
    per_backend: dict[str, int] = field(default_factory=dict)

    def over_total(self) -> bool:
        return self.total >= self.total_limit

    def over(self, candidate: BackendCandidate) -> bool:
        """Whether `candidate` is unusable for this user right now: the contrib-wide cap,
        or this backend's own cap, either one hit."""
        if self.over_total():
            return True
        if candidate.daily_limit is not None and self.per_backend.get(candidate.name, 0) >= candidate.daily_limit:
            return True
        return False


Selector = Callable[[GenerateRequest, Sequence[BackendCandidate], Usage], Sequence[BackendCandidate]]


def priority(
    request: GenerateRequest,
    candidates: Sequence[BackendCandidate],
    usage: Usage,
) -> Sequence[BackendCandidate]:
    """Drop backends over their limit (the contrib-wide one or their own), then sort the
    rest by `priority`, highest first. Ties keep the operator's declaration order
    (`sorted` is stable)."""
    eligible = [c for c in candidates if not usage.over(c)]
    return sorted(eligible, key=lambda c: c.priority, reverse=True)
