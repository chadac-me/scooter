"""Webhook handler registry: plugin discovery.

Mirrors the broker's provider registry: handler modules self-register via
@register_webhook on import, external packages contribute through the
"scooter_webhooks.handlers" entry-point group, and the packages to scan are a
parameter. Handlers self-gate in-route (a disabled provider returns
`{"status": "disabled"}`), so `enabled` is for handlers that prefer mount-time gating.
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from dataclasses import dataclass
from types import ModuleType
from typing import Callable, Iterable, Sequence

from fastapi import APIRouter

logger = logging.getLogger(__name__)

# The entry-point group external packages contribute handlers through.
ENTRY_POINT_GROUP = "scooter_webhooks.handlers"


@dataclass
class WebhookHandler:
    """One discovered handler: a name and the router it mounts."""

    name: str
    router: APIRouter
    enabled: bool = True


# A handler factory, which reads its own config.
WebhookFactory = Callable[[], WebhookHandler]

_REGISTRY: dict[str, WebhookFactory] = {}


def register_webhook(factory: WebhookFactory) -> WebhookFactory:
    """Register a handler factory, keyed by its __name__."""
    _REGISTRY[factory.__name__] = factory
    return factory


def _import_builtin_handlers(packages: Sequence[ModuleType]) -> None:
    """Import every module under each package so their @register_webhook decorators run."""
    for package in packages:
        for mod in pkgutil.iter_modules(package.__path__):
            importlib.import_module(f"{package.__name__}.{mod.name}")


def _load_entrypoint_handlers() -> None:
    """Load handlers contributed by external packages."""
    try:
        from importlib.metadata import entry_points
    except ImportError:  # pragma: no cover
        return
    for ep in entry_points(group=ENTRY_POINT_GROUP):
        try:
            ep.load()  # importing registers via @register_webhook
        except Exception:  # pragma: no cover
            logger.exception(
                "failed loading webhook handler entry-point",
                extra={"entry_point": ep.name},
            )


def discover_webhooks(
    builtin_packages: Iterable[ModuleType] = (),
) -> list[WebhookHandler]:
    """Build every registered and entry-point handler and keep the enabled ones; `builtin_packages` are scanned so their decorators run."""
    _import_builtin_handlers(tuple(builtin_packages))
    _load_entrypoint_handlers()
    handlers: list[WebhookHandler] = []
    for name, factory in _REGISTRY.items():
        try:
            handler = factory()
        except Exception:
            # A skipped handler is absent (its routes 404), which is easy to mistake for disabled, so the log names the consequence.
            logger.exception(
                "webhook handler FAILED to build and is now ABSENT (its routes "
                "will not serve) — this is a misconfiguration/bug, not a "
                "deliberate disable",
                extra={"handler": name},
            )
            continue
        if handler.enabled:
            handlers.append(handler)
    return handlers
