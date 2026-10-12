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
from scooter_broker_lib.transports.git_credential import GitCredential
from scooter_broker_lib.transports.whoami import WhoAmI

# A deterministic fake git credential, for a sentinel host that GIT_BROKER_HOST_MAP in the
# sandbox maps to the `test` provider.
TEST_GIT_HOST = "test-git.local"
TEST_GIT_USERNAME = "test-user"
TEST_GIT_PASSWORD = "test-broker-token"  # noqa: S105


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
    """The test provider, carrying a `whoami` transport and a `git-credential` transport that vends a fixed fake credential for TEST_GIT_HOST."""
    return Provider(
        name="test",
        transports=[
            WhoAmI(recorder=recorder),
            GitCredential(host=TEST_GIT_HOST, username=TEST_GIT_USERNAME),
        ],
        credential=StaticTokenSource(token=TEST_GIT_PASSWORD),
        enabled=settings.test_provider_enabled,
    )
