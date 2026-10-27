"""Real ForgeProxy and contrib providers, with a fixed CA and fake TokenReview."""

import asyncio
import os
import ssl
import sys

import httpx

from broker.forge.ca import CaMaterial, LeafIssuer
from broker.forge.proxy import ForgeProxy, ProxyAuthError, build_routes
from scooter_broker_lib.types import Identity
from scooter_lib.logging_config import configure_logging
from scooter_contrib_github.broker_provider import github
from scooter_contrib_gitlab.broker_provider import gitlab

SANDBOX_TOKEN = os.environ["SANDBOX_TOKEN"]
CERTS = os.environ["CERTS"]


async def authenticate(token: str) -> Identity:
    if token != SANDBOX_TOKEN:
        raise ProxyAuthError(407, "unknown sandbox token")
    return Identity(
        conversation_id="forge01",
        namespace="agent-sandbox",
        service_account="system:serviceaccount:agent-sandbox:sandbox-forge01",
    )


def read(name: str) -> bytes:
    with open(os.path.join(CERTS, name), "rb") as f:
        return f.read()


async def main() -> None:
    # Structured logs, so the policy audit line shows its reason.
    configure_logging("broker")
    providers = [github(), gitlab()]
    if not all(p.enabled for p in providers):
        sys.exit("a contrib provider is disabled: GITHUB_TOKEN/GITLAB_TOKEN not reaching it")
    routes = build_routes(providers)
    # The published hosts file must match what the contribs declare.
    published = sorted(read("hosts").decode().split())
    if sorted(routes) != published:
        sys.exit(f"contribs declare {sorted(routes)}, the test publishes {published}")
    upstream = httpx.AsyncClient(
        verify=ssl.create_default_context(cafile=os.path.join(CERTS, "upstream-ca.crt")),
        timeout=60,
    )
    proxy = ForgeProxy(routes, LeafIssuer(CaMaterial(read("ca.crt"), read("ca.key"))), authenticate, upstream=upstream)
    await proxy.start("0.0.0.0", int(os.environ["PORT"]))
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
