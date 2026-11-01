"""Discovery for imagegen's own plugin surface: backends and selectors, each its own
entry-point group — the same shape `scooter_broker_lib.registry` uses for providers,
so a backend or a selector can ship from an out-of-tree package. A failing entry
point is skipped and logged rather than failing the whole broker.
"""

from __future__ import annotations

import logging
from importlib.metadata import EntryPoint, entry_points
from typing import Callable, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

BACKENDS_GROUP = "scooter_imagegen.backends"
SELECTORS_GROUP = "scooter_imagegen.selectors"


def _load(group: str, build: Callable[[EntryPoint], T]) -> dict[str, T]:
    loaded: dict[str, T] = {}
    for ep in entry_points(group=group):
        try:
            loaded[ep.name] = build(ep)
        except Exception:
            logger.exception("failed loading %s entry-point %r", group, ep.name)
    return loaded


def discover_backends() -> dict[str, "Backend"]:  # noqa: F821 (manifest.Backend, a Protocol)
    """name -> Backend instance, built by calling each entry point's zero-arg factory."""
    return _load(BACKENDS_GROUP, lambda ep: ep.load()())


def discover_selectors() -> dict[str, "Selector"]:  # noqa: F821 (selectors.Selector)
    """name -> selector function. No call: the entry point IS `select(request, candidates, usage)`."""
    return _load(SELECTORS_GROUP, lambda ep: ep.load())
