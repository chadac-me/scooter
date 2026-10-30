# The declaration

Every contrib starts with `contrib.nix`, which says what the contrib *is*, and a Python
package named `scooter_contrib_<name>`.

## `contrib.nix`

Here is `acme`'s finished `contrib.nix`:

```nix
# contrib/acme/contrib.nix
# Only `lib` is available here; see "What this file can use" below.
{ lib, ... }:
let
  clib = import ../lib.nix { inherit lib; };
in
{
  # `config` is this contrib's own: contribs.acme.
  contribs.acme = { config, ... }: {
    # ── What the operator configures, as contribs.acme.* ─────────────────────
    options = {
      # The Secret holding the API token: contribs.acme.tokenSecret.{name,key}.
      tokenSecret = clib.mkSecretOption {
        key = "ACME_TOKEN";
        holds = "the Acme API token";
        description = "Secret holding the Acme API token.";
      };
      # A plain setting: contribs.acme.siteUrl.
      siteUrl = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "Base URL of the Acme web UI, for links shown to people.";
      };
    };

    # ── What the contrib is ───────────────────────────────────────────────────
    config = {
      # No `enable` here: every contrib is off by default. See "Turning it on"
      # below.

      # The contrib's own directory: the Python package, skills, icon.
      src = ./.;

      # Which images the Python package is built into. Each half loads only its
      # own module: broker_provider.py in the broker, webhooks_handler.py in
      # the webhooks service.
      services.broker = {
        enable = true;
        # The broker container's env: a string is a value, a Secret option a
        # secretKeyRef, and `lib.mkIf` leaves a variable out.
        env = {
          ACME_TOKEN = config.tokenSecret;
          ACME_SITE_URL = lib.mkIf (config.siteUrl != "") config.siteUrl;
        };
      };
      services.webhooks = {
        enable = true;
        # Extra Python dependencies for this half only.
        pythonDeps = ps: [ ps.httpx ];
      };

      # The agent's instructions, shipped when the contrib is enabled.
      skills."scooter-acme.md" = ./skills/scooter-acme.md;

      # A NixOS module added to the sandbox image.
      sandbox.module = ./sandbox.nix;

      # Brand row and tool cards in the chat UI.
      ui.source = { label = "Acme"; icon = ./icon.svg; color = "#E5484D"; };
      ui.tools.acme_comment = { argKey = "body"; action = "commented on Acme"; };
    };
  };
}
```

`skills`, `sandbox.module` and `ui` each have their own page: [Skills](skills.md),
[The sandbox module](sandbox.md) and [UI metadata](ui.md). A contrib that raises human
approvals also sets `approvals` (see [the broker provider](broker.md#human-approvals)).
Leave out any part your contrib doesn't need.

### Turning it on

!!! warning "A new contrib does nothing until you enable it, in two places"
    Every contrib is off by default, including your own, so writing one doesn't
    activate it anywhere. Turn it on in both of these:

    1. **The images.** Enable it in `.github/deployment/config.nix`, the contrib set CI
       builds into the published broker, webhooks and sandbox images. Without this its
       code isn't in the images at all.

        ```nix
        # .github/deployment/config.nix
        contribs.acme.enable = true;
        ```

    2. **Your deployment.** Enable and configure it in your `scooter.nix`, like any
       shipped contrib. Without this nothing renders: no env vars, no skill, no routes.

        ```nix
        # scooter.nix
        contribs.acme = {
          enable = true;
          tokenSecret.name = "acme-token";
          siteUrl = "https://acme.example/acme-corp";
        };
        ```

    Don't set `enable = true` in `contrib.nix` itself. It would switch the contrib on in
    every deployment, which then fail to render unless they configure `tokenSecret`,
    and a deployment could no longer turn it off without `lib.mkForce`.

### What this file can use

`contrib.nix` is read by every evaluation that touches contribs: the package build, the
Kubernetes render, and the sandbox image, including its in-pod rebuild. Some of those
have no `pkgs` and no `scooter.*` options, so this file may use **only `lib`**. It
declares; it doesn't render. Env for the broker and webhooks containers goes in
`services.<svc>.env`; any other Kubernetes config goes in [`deployment.nix`](deployment.md).

### Options

Everything under `options` is a deployment setting, declared with the ordinary
`lib.mkOption`. Give each one a `type`, a `description` and, where it makes sense, a
`default` and an `example`, because they show up in the
[configuration reference](../../reference/options/index.md).

- **Name options flatly.** Use `contribs.acme.siteUrl`, not `contribs.acme.acme.siteUrl`:
  `contribs.acme` already says which integration it is.
- **Nest only where the thing is nested**, such as a Secret reference's `{ name, key }`.
- **Refer to Secrets, never hold their values.** Declare one with `mkSecretOption` from
  `contrib/lib.nix`. It takes a Secret's name and key, and putting it in
  `services.<svc>.env` renders a `secretKeyRef`.

Configuring an option of a contrib that isn't enabled fails the render, so a deployment
can never half-configure an integration.

### Services

`services` has a fixed set of keys, `broker` and `webhooks`, so a typo like
`services.brokr` is an evaluation error rather than a half that silently never gets
built. A contrib that needs neither, like the sandbox-only `contrib/code-server`, leaves
`services` out.

`pythonDeps` receives a package set that also contains the other contribs, under
`ps.scooterContrib.<name>`. That is how gitlab's webhooks half depends on jira's
issue-key parser:

```nix
services.webhooks.pythonDeps = ps: [ ps.scooterContrib.jira ];
```

## The Python package

The Python package registers its halves through **entry points**. At startup, each
service loads every factory in its group. You don't write a `pyproject.toml` for this:
`contrib/build.nix` generates one from `contrib.nix`, with one entry point for each
enabled service:

| Service | Entry point group | Entry point |
|---|---|---|
| `broker` | `agent_broker.providers` | `acme = "scooter_contrib_acme.broker_provider:acme"` |
| `webhooks` | `scooter_webhooks.handlers` | `acme = "scooter_contrib_acme.webhooks_handler:acme"` |

So each factory function must be named after the contrib. Python dependencies go in
`services.<svc>.pythonDeps`; `fastapi` and the service's extension library are always
included. Tests run with pytest's `asyncio_mode = "auto"`. If a contrib really needs
something else, a `pyproject.toml` in its directory replaces the generated one.

The package is `scooter_contrib_acme`. Keep its `__init__.py` **import-light**: it must
import neither the broker nor the webhooks library, because each image only has one of
them.

```python
# contrib/acme/scooter_contrib_acme/__init__.py
"""Acme Tracker integration for Scooter."""
```

Settings are read from environment variables, which `services.<svc>.env` sets. Subclass
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
platform finds a `deployment.nix` next to `contrib.nix` by name, if there is one.

Then enable it in the images and in your deployment, as in
[Turning it on](#turning-it-on).

Next: [the deployment half](deployment.md).
