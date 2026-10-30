"""Where create_app() mounts a provider's routes: under /<name>, or at / when it asks to."""

from __future__ import annotations

import pytest

from scooter_broker_lib import registry
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.whoami import WhoAmI
from scooter_broker_lib.types import Provider


@pytest.fixture
def probes():
    @register_provider
    def prefixed_probe() -> Provider:
        return Provider(name="prefixed-probe", transports=[WhoAmI()])

    @register_provider
    def root_probe() -> Provider:
        return Provider(name="root-probe", transports=[WhoAmI()], mount_at_root=True)

    try:
        yield
    finally:
        registry._REGISTRY.pop("prefixed_probe", None)
        registry._REGISTRY.pop("root_probe", None)


def test_a_provider_mounts_under_its_name_by_default(probes):
    from broker.core.app import create_app

    paths = create_app().openapi()["paths"]
    assert "/prefixed-probe/whoami" in paths, f"mounted: {sorted(paths)}"


def test_mount_at_root_drops_the_prefix(probes):
    from broker.core.app import create_app

    paths = create_app().openapi()["paths"]
    assert "/whoami" in paths, f"mounted: {sorted(paths)}"
    assert "/root-probe/whoami" not in paths
