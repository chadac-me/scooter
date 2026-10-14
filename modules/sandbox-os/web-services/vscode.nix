# webServices.vscode: a browser VS Code (code-server) served under
# /c/<id>/vscode/, with the proxy stripping that prefix because code-server has
# no base-path flag. `pkgs.code-server` is a nix-stubs shim built on first
# start. This module only supplies mkDefault values and must not gate on
# `cfg.enable` (infinite recursion); web-services.nix filters on `.enable`.

{ config, lib, pkgs, ... }:

let
  cfg = config.webServices.vscode;
in
{
  # The code-server shim on PATH, so the agent can run it by hand.
  environment.systemPackages = lib.mkIf cfg.enable [ pkgs.code-server ];

  webServices.vscode = {
    port = lib.mkDefault 8443;
    displayName = lib.mkDefault "VS Code";
    # Root, like the agent's own exec'd shell, so the editor operates on the /workspace PVC.
    user = lib.mkDefault "root";
    workingDirectory = lib.mkDefault "/workspace";
    # `command` is types.str, so the derivation is interpolated to its store path for the re-converge eval.
    command = lib.mkDefault "${pkgs.writeShellScript "vscode-web-service" ''
      set -euo pipefail
      # --auth none because the platform proxy gates access; state lives under HOME=/workspace so it persists across suspend/resume.
      exec ${pkgs.code-server}/bin/code-server \
        --bind-addr "0.0.0.0:${toString cfg.port}" \
        --auth none \
        --disable-telemetry \
        --disable-update-check \
        /workspace
    ''}";
    # The proxy strips /c/<id>/vscode before forwarding, so code-server serves at root.
    stripBasePath = lib.mkDefault true;
  };
}
