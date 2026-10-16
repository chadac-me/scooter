"""The files provider: the annotation store the sandbox viewer syncs to.

Mounted as an ordinary provider, so the broker core carries no annotation code and
nothing about this feature appears in `modules/broker.nix`. What it takes from the
platform is only what the platform already offers every contrib: `ctx.store_config`
(the shared `broker` database) and the core auth dependency the transport receives.

Off unless `files_annotations_enabled`, and then the routes are ABSENT rather than
failing — the registry drops a disabled provider, so a viewer built against a
deployment that stores no annotations gets a 404, which reads as "not enabled here".
"""

from __future__ import annotations

import logging

from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider

from .annotations_transport import Annotations
from .config import settings
from .store import AnnotationStore

logger = logging.getLogger(__name__)


@register_provider
def files(ctx: BrokerContext) -> Provider:
    transport = Annotations()

    if not settings.files_annotations_enabled:
        return Provider(name="files", transports=[transport], enabled=False)

    transport.set_store(AnnotationStore(ctx.store_config))

    # No credential: nothing here is proxied to a third party, and the only secret
    # in the flow is the caller's own SA token, which the core already validates.
    return Provider(name="files", transports=[transport], enabled=True)
