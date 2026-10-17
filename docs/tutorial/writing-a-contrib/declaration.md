# The declaration

Every contrib starts with two files: `contrib.nix` says what the contrib *is* to Nix, and
`pyproject.toml` says what it is to Python.

## `contrib.nix`

`contrib.nix` defines `contribs.acme`. It's read by every evaluation that touches
contribs: the package build, the Kubernetes render, and the sandbox image (including its
in-pod rebuild). Some of those have no `pkgs` and no `scooter.*` options, so this file may
use **only `lib`**. It declares options; it doesn't render anything.

```nix
# contrib/acme/contrib.nix
{ lib, ... }:
{
  contribs.acme = {
    # Options the OPERATOR sets, under contribs.acme.*.
    options.tokenSecret = lib.mkOption {
      type = lib.types.submodule {
        options = {
          name = lib.mkOption {
            type = lib.types.str;
            description = "Secret name (in Scooter's namespace).";
          };
          key = lib.mkOption {
            type = lib.types.str;
            default = "ACME_TOKEN";
            description = "Secret key holding the Acme API token.";
          };
        };
      };
      description = "Secret holding the Acme API token. Injected into the broker as ACME_TOKEN.";
    };

    options.siteUrl = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "https://acme.example/acme-corp";
      description = "Base URL of the Acme web UI, for the links the agent shows people.";
    };

    # What the contrib IS.
    config = {
      src = ./.;
      services.broker.enable = true;
      services.webhooks.enable = true;
    };
  };
}
```

The two halves of the file:

- **`options.*`** are the deployment settings. The operator sets them as
  `contribs.acme.tokenSecret.name = "…"`, and your [deployment half](deployment.md) reads
  them. Name them flatly: `contribs.acme.siteUrl`, not `contribs.acme.acme.siteUrl`.
  Nest only where the thing is genuinely nested, such as a Secret's `{ name, key }`.
- **`config.*`** are the fields every contrib shares:

| Field | Meaning |
|---|---|
| `src` | The contrib's directory. Always `./.` |
| `services.broker.enable`, `services.webhooks.enable` | Which images this contrib's Python package is built into |
| `services.<svc>.pythonDeps` | Extra Python dependencies for that half only, e.g. `ps: [ ps.httpx ]` |
| `skills` | Skill files the agent gets when the contrib is enabled ([Skills](skills.md)) |
| `sandbox.module` | A NixOS module for the sandbox image ([Sandbox](sandbox.md)) |
| `ui` | Brand row and tool cards for the chat UI ([UI](ui.md)) |
| `approvals` | How the UI presents this contrib's human approvals ([Broker provider](broker.md#human-approvals)) |

`services` has a fixed set of keys, so a typo like `services.brokr` is an evaluation
error rather than a half that silently never gets built.

**Don't set `enable` here.** It defaults to `false`, and the operator turns the contrib
on. Configuring an option of a contrib that isn't enabled fails the render, so a
deployment can never half-configure an integration.

`pythonDeps` receives a package set that also contains the other contribs, under
`ps.scooterContrib.<name>`. That is how gitlab's webhooks half depends on jira's
issue-key parser:

```nix
services.webhooks.pythonDeps = ps: [ ps.scooterContrib.jira ];
```

## `pyproject.toml`

The Python package registers its halves through **entry points**. At startup, each
service loads every factory in its group:

```toml
# contrib/acme/pyproject.toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "scooter-contrib-acme"          # fixed by convention: scooter-contrib-<name>
version = "0.0.0"
license = "MIT"
description = "Acme Tracker integration for Scooter"
requires-python = ">=3.11"
# Never depend on the broker or webhooks apps: they depend on their contribs.
dependencies = ["fastapi"]

# One extra per service, so the webhooks surface never lands in the broker image.
[project.optional-dependencies]
broker = ["scooter-broker-lib", "scooter-lib"]
webhooks = ["scooter-webhooks-lib", "scooter-lib"]

[project.entry-points."agent_broker.providers"]
acme = "scooter_contrib_acme.broker_provider:acme"

[project.entry-points."scooter_webhooks.handlers"]
acme = "scooter_contrib_acme.webhooks_handler:acme"

[tool.pytest.ini_options]
asyncio_mode = "auto"
```

The package is `scooter_contrib_acme`. Keep its `__init__.py` **import-light**: it must
import neither the broker nor the webhooks library, because each image only has one of
them.

```python
# contrib/acme/scooter_contrib_acme/__init__.py
"""Acme Tracker integration for Scooter."""

CONTRIB_NAME = "acme"
```

Settings are read from environment variables, which your deployment half sets. Subclass
`ScooterBaseSettings`: each field reads the variable of the same name, upper-cased.

```python
# contrib/acme/scooter_contrib_acme/config.py
from scooter_lib.settings import ScooterBaseSettings


class AcmeSettings(ScooterBaseSettings):
    acme_token: str = ""            # ACME_TOKEN
    acme_site_url: str = ""         # ACME_SITE_URL
    acme_webhook_secret: str = ""   # ACME_WEBHOOK_SECRET
    acme_enabled: bool = False      # ACME_ENABLED
```

## Register it

Add the contrib to the explicit list in `contrib/all-modules.nix`:

```nix
imports = [
  ./spec.nix
  ./acme/contrib.nix
  ./airtable/contrib.nix
  # …
];
```

The list is deliberately explicit, not a directory scan, and `just check-contrib-coverage`
fails CI if a contrib directory is missing from it. Nothing else needs editing: the
platform finds `deployment.nix` next to `contrib.nix` by name.

To have the repo's own images include `acme`, enable it in `.github/deployment/config.nix`,
the contrib set CI builds and publishes:

```nix
contribs.acme.enable = true;
```

Next: [the deployment half](deployment.md).
