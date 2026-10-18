# webServices.marimo: a marimo notebook served under /c/<id>/marimo/, with
# `--base-url` and `--proxy` read from the pod env at start. `pkgs.marimo` is a
# nix-stubs shim that materializes on first start. This module only supplies
# mkDefault values and must not gate on `cfg.enable` (infinite recursion); the
# parent web-services.nix filters on `.enable` when it renders units.

{ config, lib, pkgs, uvNix ? null, ... }:

let
  cfg = config.webServices.marimo;
in
{
  # The marimo shim on PATH, so the agent can run it by hand.
  environment.systemPackages = lib.mkIf cfg.enable [ pkgs.marimo ];

  webServices.marimo = {
    port = lib.mkDefault 2718;
    displayName = lib.mkDefault "marimo";
    # Root, like the agent's own exec'd shell, so notebooks land on the /workspace PVC.
    user = lib.mkDefault "root";
    workingDirectory = lib.mkDefault "/workspace";
    # Pin uv to a Nix-provided Python, since a downloaded CPython cannot exec on NixOS.
    environment = lib.mkIf (uvNix != null) (lib.mkDefault {
      UV_PYTHON = "${pkgs.python314}/bin/python3.14";
      UV_PYTHON_DOWNLOADS = "never";
    });

    # Under uv-nix each notebook gets a uv-managed venv with patched wheels so native deps import; without it, a bare `marimo edit` still boots.
    command =
      let
        uvBin = if uvNix != null then "${uvNix}/bin/uv" else null;
        runner =
          if uvBin != null
          # --sandbox makes each notebook self-contained with its inline PEP 723 deps.
          then ''exec ${uvBin} run --with marimo marimo edit --sandbox''
          else "exec ${pkgs.marimo}/bin/marimo edit";
      in
      # `command` is types.str, so the derivation is interpolated to its store path for the re-converge eval.
      lib.mkDefault "${pkgs.writeShellScript "marimo-web-service" ''
        set -euo pipefail
        base="''${SCOOTER_SERVICE_PREFIX-/c/''${CONVERSATION_ID:-unknown}}/marimo"
        proxy_args=()
        if [ -n "''${PUBLIC_HOST:-}" ]; then proxy_args+=(--proxy "''${PUBLIC_HOST}"); fi
        # --no-token: access is gated by the platform proxy, and marimo-pair needs a token-less server.
        ${runner} \
          --host 0.0.0.0 --port ${toString cfg.port} \
          --base-url "$base" "''${proxy_args[@]}" \
          --headless --no-token
      ''}";
  };
}
