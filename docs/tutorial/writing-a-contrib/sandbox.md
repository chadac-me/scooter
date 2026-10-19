# The sandbox module

Some integrations need something inside the agent's sandbox: a CLI, a config file, a
background service. A contrib adds these with `sandbox.nix`, a plain **NixOS module**
that's layered into the sandbox image.

```nix
# contrib/acme/contrib.nix
config = {
  src = ./.;
  sandbox.module = ./sandbox.nix;
};
```

```nix
# contrib/acme/sandbox.nix
{ pkgs, ... }:
{
  environment.systemPackages = [
    # A thin wrapper so the agent can type `acme issue ENG-42`.
    (pkgs.writeShellScriptBin "acme" ''
      case "$1" in
        issue) exec agent-broker "acme/v1/issues/$2" ;;
        *) echo "usage: acme issue <KEY>" >&2; exit 2 ;;
      esac
    '')
  ];

  environment.etc."acme/config.toml".text = ''
    api = "broker"
  '';
}
```

There's no special schema. A package is `environment.systemPackages`, a daemon is a
`systemd.services.<name>`, and a file is `environment.etc`. You don't need `mkIf` either:
a disabled contrib's module is never imported.

A contrib can be **sandbox-only**, with no `services.*` at all. `contrib/code-server` is:
it just puts VS Code in the sandbox.

## Rules for sandbox modules

The agent can rebuild its own sandbox at runtime (to install tools, for example). That
rebuild runs **inside the pod**, with no network and no flake, from a copy of the Scooter
source tree baked into the image. It replays your module from that copy. So:

- **Use only `pkgs` and plain NixOS options.** Anything that fetches at evaluation time
  works in CI and then fails in the pod.
- **Keep paths relative and inside the repo.** `../../pkgs/…` resolves the same on both
  sides. A path outside the Scooter tree doesn't exist in the pod.
- **No secrets.** The sandbox is the agent's. Credentials belong in the broker; give the
  sandbox a CLI that calls `agent-broker` instead, as above.

To pass deployment config into the sandbox (a ConfigMap, an env var), use
`scooter.sandboxPod.extraEnv`/`extraVolumes`/`extraVolumeMounts` from your
[deployment half](deployment.md). `contrib/aws` mounts its account list into every
sandbox that way, and its `sandbox.nix` renders `~/.aws/config` from it.

`contrib/echo/sandbox.nix` is the smallest example, and the `dev-env-contrib-sandbox`
check asserts its marker file reaches the image.

Next: [UI metadata](ui.md).
