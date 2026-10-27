"""The `test` provider for end-to-end credential-path testing.

It carries no real secret: its `whoami` transport authenticates the caller through the
same SA-token path every real provider uses, returns the validated Identity and records
the call. Enabled only when config.test_provider_enabled.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..config import settings
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Identity, Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.whoami import WhoAmI


@dataclass
class CallRecorder:
    """In-memory record of authenticated calls, for tests to assert against."""

    calls: list[Identity] = field(default_factory=list)

    def record(self, identity: Identity) -> None:
        self.calls.append(identity)


# Shared recorder the WhoAmI transport writes to and tests read.
recorder = CallRecorder()


@register_provider
def echo() -> Provider:
    """The test provider, carrying a `whoami` transport."""
    return Provider(
        name="test",
        transports=[
            WhoAmI(recorder=recorder),
        ],
        credential=StaticTokenSource(token="test-broker-token"),  # noqa: S106
        enabled=settings.test_provider_enabled,
    )
