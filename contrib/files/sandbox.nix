# files' sandbox half: a read-only viewer over the workspace PVC, served under
# /c/<id>/files/. The viewer runs in the pod, so listing and reading are ordinary
# local filesystem calls and nothing on the control plane grows a file-read
# endpoint. Like every web service the unit is explicit-start, so declaring it
# costs a manifest entry and no running process.
#
# Supplies mkDefault values only and must not gate on `cfg.enable` (infinite
# recursion); web-services.nix filters on `.enable` when it renders units.

{ config, lib, pkgs, ... }:

let
  cfg = config.webServices.files;

  # The viewer's own tree — server.py plus static/ — as one store path, so
  # `STATIC = __file__/../static` resolves at runtime.
  viewer = builtins.path { path = ./viewer; name = "scooter-files-viewer"; };

  # The pinned browser assets (markdown-it, DOMPurify, highlight.js), kept as their
  # own store path rather than copied into `viewer` so that editing server.py does
  # not re-fetch them, and so the source tree stays free of vendored blobs.
  vendor = pkgs.callPackage ./viewer/deps.nix { };
in
{
  webServices.files = {
    enable = lib.mkDefault true;
    port = lib.mkDefault 7801;
    displayName = lib.mkDefault "Files";
    # Root, like the agent's own exec'd shell, so the viewer sees the /workspace
    # PVC exactly as the agent wrote it.
    user = lib.mkDefault "root";
    workingDirectory = lib.mkDefault "/workspace";

    # stripBasePath stays at its default of false: the viewer is told its own
    # prefix and emits every link under it, so stripping would double-strip.
    #
    # `command` is types.str, so the derivation is interpolated to its store path
    # for the re-converge eval.
    command = lib.mkDefault "${pkgs.writeShellScript "files-web-service" ''
      set -euo pipefail
      # CONVERSATION_ID arrives via the unit's conv.env; this must match the prefix
      # the proxy forwards or every asset 404s.
      export SCOOTER_FILES_BASE="/c/''${CONVERSATION_ID:-unknown}/files"
      export SCOOTER_FILES_PORT="${toString cfg.port}"
      export SCOOTER_FILES_ROOT="''${SCOOTER_FILES_ROOT:-/workspace}"
      # Without this the page still renders, as plain text: every rich renderer is
      # feature-detected, so a viewer built without the assets degrades rather than
      # breaking. /api/health reports which of the two happened.
      export SCOOTER_FILES_VENDOR="${vendor}"
      exec ${pkgs.python3}/bin/python3 ${viewer}/server.py
    ''}";
  };
}
