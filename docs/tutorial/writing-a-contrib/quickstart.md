# Quick start: a broker in two files

The rest of this chapter builds `acme` with every part a contrib can have. This page
is the short version, for the common case: **the agent needs an API, with a token it
must never see.** That takes a declaration (`contrib.nix`) and a provider
(`broker_provider.py`), both below, and nothing else. It is also what the smallest
shipped contrib, `contrib/airtable`, is.

## Proxy, tools, or both?

The broker offers two ways to put an API in front of the agent. Pick by what the agent
does with it; a contrib can have both.

| You want | Use | The agent sees |
|---|---|---|
| The whole API, with the credential added | `HttpProxy` | `agent-broker acme/v1/issues/ENG-42` from its shell: a normal HTTP response, never the token |
| A few typed operations it must get right | `McpTools` on a [FastMCP](https://gofastmcp.com) server | `acme_comment(issue, body)` in its tool list, with a docstring and a real error status |
| `git`, `gh`, `glab` against a host | `ForgeHosts` | Those CLIs just work in the sandbox (how `contrib/github` does it) |

Start with the proxy. [Agent tools](tools.md) adds typed tools to the same provider in
~20 lines when you find the agent fumbling one call.

## 1. The declaration

```nix
# contrib/acme/contrib.nix
{ lib, ... }:
let
  clib = import ../lib.nix { inherit lib; };
in
{
  contribs.acme = { config, ... }: {
    # contribs.acme.tokenSecret.{name,key}: the Secret the operator creates.
    options.tokenSecret = clib.mkSecretOption {
      key = "ACME_TOKEN";
      holds = "the Acme API token";
      description = "Secret holding an Acme API token. Injected as ACME_TOKEN.";
    };
    config = {
      src = ./.;
      services.broker = {
        enable = true;
        env.ACME_TOKEN = config.tokenSecret;   # a secretKeyRef in the broker's env
      };
    };
  };
}
```

## 2. The provider

Three files make the Python package `scooter_contrib_acme`:

```python
# contrib/acme/scooter_contrib_acme/__init__.py
"""Acme integration for Scooter's broker."""
```

```python
# contrib/acme/scooter_contrib_acme/config.py
from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class AcmeSettings(ScooterBaseSettings):
    acme_token: str = ""            # read from ACME_TOKEN
```

```python
# contrib/acme/scooter_contrib_acme/broker_provider.py
"""Acme provider: proxies /acme/* to the Acme API with the token added."""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Provider


@register_provider
def acme() -> Provider:
    from .config import AcmeSettings

    token = AcmeSettings().acme_token.strip()
    return Provider(
        name="acme",                                   # mounts /acme/*
        credential=StaticTokenSource(token=token),     # Authorization: Bearer <token>
        transports=[HttpProxy(upstream="https://api.acme.example")],
        enabled=bool(token),                           # no token, no routes
    )
```

The factory's name must be the contrib's name. For a token in a custom header, use
`StaticTokenSource(token=token, kind="header", header_name="X-Api-Key")`; for tokens
minted per request, write a `CredentialSource` (see [the broker provider](broker.md#credentials)).

## 3. Register and test it

A contrib is only built if the repo knows about it. Four one-line additions:

| Where | What |
|---|---|
| `contrib/all-modules.nix` | `./acme/contrib.nix` in `imports` (`just check-contrib-coverage` fails without it) |
| `examples/kubenix-config.nix` | `contribs.acme = { enable = true; tokenSecret.name = "acme-token"; };` (`just check-manifests` requires every shipped contrib's options to be exercised) |
| `.github/deployment/config.nix` | `contribs.acme.enable = true;` so CI builds it into the published broker image |
| `contrib/acme/tests/test_acme.py` | The test below; it runs inside the package build |

```python
# contrib/acme/tests/test_acme.py
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_contrib_acme.broker_provider import acme


def test_disabled_without_a_token(monkeypatch):
    monkeypatch.delenv("ACME_TOKEN", raising=False)
    assert acme().enabled is False


def test_proxies_to_the_acme_api(monkeypatch):
    monkeypatch.setenv("ACME_TOKEN", "acme-secret")
    provider = acme()
    assert provider.enabled
    proxy = next(t for t in provider.transports if isinstance(t, HttpProxy))
    assert proxy.upstream == "https://api.acme.example"
```

```bash
nix build .#contrib-acme -L     # builds the package and runs its tests
just ci                         # the platform-side checks
```

## 4. Turn it on

Contribs are code in the broker image, so the image must contain yours: either
[upstream it](index.md#where-a-contrib-lives), or publish images from a fork and point
`scooter.registryPrefix` at them. Then, in the deployment:

```nix
# scooter.nix
contribs.acme = {
  enable = true;
  tokenSecret.name = "acme-token";   # a Secret in Scooter's namespace with key ACME_TOKEN
};
```

The broker now mounts `/acme/*`, and the agent can call the API:

```bash
agent-broker acme/v1/issues/ENG-42 | jq .title
```

Add a [skill](skills.md) so the agent knows the route exists and what the API looks
like; without one it has no reason to try `agent-broker acme/…`.

## What this doesn't cover

- **A contrib is not deployment config.** There is no Nix-only form
  (`contribs.foo = { upstream = …; }`) that skips the Python package: the provider has to
  be in the image. The two files above are the floor.
- **Webhooks, approvals, databases, UI, sandbox packages** each have a page in this
  chapter. Add them to the same contrib when you need them; the declaration grows one
  block per part.

Next: the full walkthrough, starting with the [declaration](declaration.md).
