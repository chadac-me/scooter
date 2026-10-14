"""What the broker hands a provider: the deployment-level substrate a provider must not build itself.

The `authorizer` is the enforcement point and the `store_config` is the shared
`broker` database's DSN; the app builds both once and passes them to any factory
that declares a parameter.
"""

from __future__ import annotations

from dataclasses import dataclass

from .authz import Authorizer
from .store import StoreConfig


@dataclass(frozen=True)
class BrokerContext:
    """Substrate the broker supplies to a provider factory that asks for it."""

    authorizer: Authorizer
    store_config: StoreConfig
