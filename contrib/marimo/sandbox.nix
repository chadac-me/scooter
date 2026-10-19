# marimo's sandbox half. The user-facing service is webServices.marimo, "marimo + chat":
# a static page with this conversation beside the notebook. The marimo server it frames
# is webServices.marimo-server, unlisted (no Services panel entry), started and stopped
# with it, and served under /c/<id>/marimo-server/ with `--base-url` and `--proxy`
# read from the pod env at start.
# `pkgs.marimo` is a nix-stubs shim (modules/sandbox-os/stubs.nix) that materializes
# on first start, so declaring the service costs a manifest entry and no running
# process. curl and jq are here for marimo-pair's scripts
# (/etc/scooter/skills/marimo-pair).
#
# Supplies mkDefault values only and must not gate on `cfg.enable` (infinite
# recursion); web-services.nix filters on `.enable` when it renders units.

{ config, lib, pkgs, uvNix ? null, ... }:

let
  cfg = config.webServices.marimo;
  srv = config.webServices.marimo-server;
  srvUnit = "webservice-marimo-server.service";

  # "marimo + chat": index.html with the conversation's chat URL filled in, served static.
  # On the conversation's own origin the path carries no id, so it is templated at start
  # from conv.env. SCOOTER_CHAT_URL overrides the chat pane (e.g. before /chat/<id> exists).
  notebookServer = pkgs.writeShellScript "notebook-web-service" ''
    set -euo pipefail
    www="''${RUNTIME_DIRECTORY%%:*}/www"
    mkdir -p "$www"
    app="''${CONVERSATION_URL:-}"
    chat="''${SCOOTER_CHAT_URL:-}"
    if [ -z "$chat" ] && [ -n "$app" ] && [ -n "''${CONVERSATION_ID:-}" ]; then
      chat="$(printf %s "$app" | sed -n 's|^\(https\{0,1\}://[^/]*\).*|\1|p')/chat/$CONVERSATION_ID"
    fi
    esc() { printf %s "$1" | sed 's/[&|\\]/\\&/g'; }
    sed -e "s|@CHAT_URL@|$(esc "$chat")|g" -e "s|@APP_URL@|$(esc "$app")|g" \
      ${./notebook/index.html} > "$www/index.html"
    exec ${pkgs.darkhttpd}/bin/darkhttpd "$www" --addr 0.0.0.0 --port ${toString cfg.port} --no-listing --no-server-id
  '';

  # marimo 0.25 opens a notebook with every cell stale (runtime.auto_instantiate
  # defaults to false). Here a visit is how the user asks for the notebook, often from a
  # bookmark that wakes the sandbox, so it should arrive computed. This is a user-level
  # default: it is written only while marimo has no settings of its own, and anything the
  # user or agent sets afterwards wins.
  # Printed by `scooter-service start|status marimo`, since the skill's body
  # can drop out of a long session's context. Mirrors scooter-marimo.md.
  hint = ''
    Packages: marimo-pair's ctx.packages.add(), never pip, a venv or a pyproject.toml (each notebook has its own environment).
    Settings: ~/.config/marimo/marimo.toml. More in the scooter-marimo skill.
  '';

  defaultSettings = (pkgs.formats.toml { }).generate "marimo-default-settings.toml" {
    runtime.auto_instantiate = true;
  };
  # Every place marimo reads user settings from counts; marimo itself leaves an empty file.
  seedSettings = pkgs.writeShellScript "marimo-seed-settings" ''
    set -eu
    settings="''${XDG_CONFIG_HOME:-$HOME/.config}/marimo/marimo.toml"
    if [ ! -s "$settings" ] && [ ! -s "$HOME/.marimo.toml" ] && [ ! -s .marimo.toml ]; then
      ${pkgs.coreutils}/bin/mkdir -p "$(${pkgs.coreutils}/bin/dirname "$settings")"
      ${pkgs.coreutils}/bin/install -m 644 ${defaultSettings} "$settings"
    fi
  '';
in
{
  # The marimo shim on PATH, so the agent can run it by hand, and what marimo-pair's
  # scripts call: they talk to the running server's HTTP API with curl and jq.
  environment.systemPackages = lib.mkIf srv.enable [ pkgs.marimo pkgs.curl pkgs.jq ];

  # The conversation beside the notebook: a static page framing `/chat/<id>` (left) and
  # marimo-server (right), both ingress URLs, so nothing is proxied here. Served at root
  # (stripBasePath), so its relative `../marimo-server/` works on either base path.
  webServices.marimo = {
    enable = lib.mkDefault true;
    port = lib.mkDefault 2720;
    displayName = lib.mkDefault "marimo + chat";
    stripBasePath = lib.mkDefault true;
    command = lib.mkDefault "${notebookServer}";
    hint = lib.mkDefault hint;
    # Starting the page starts the server it frames.
    extraConfig.wants = [ srvUnit ];
  };

  # The marimo server itself: unlisted, so "marimo + chat" is the only way in. It is
  # PartOf the page's unit, so stopping or restarting `marimo` does the same to it.
  webServices.marimo-server = {
    enable = lib.mkDefault cfg.enable;
    port = lib.mkDefault 2718;
    displayName = lib.mkDefault "marimo server";
    listed = lib.mkDefault false;
    extraConfig.partOf = [ "webservice-marimo.service" ];
    # Root, like the agent's own exec'd shell, so notebooks land on the /workspace PVC.
    user = lib.mkDefault "root";
    workingDirectory = lib.mkDefault "/workspace";
    environment = lib.mkDefault ({
      # marimo's settings live in the agent's own ~/.config on the workspace PVC, not in
      # root's home, which a pod rebuild discards. uv's cache stays out of the PVC.
      XDG_CONFIG_HOME = "/workspace/.config";
    } // lib.optionalAttrs (uvNix != null) {
      # Pin uv to a Nix-provided Python, since a downloaded CPython cannot exec on NixOS.
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
        base="''${SCOOTER_SERVICE_PREFIX-/c/''${CONVERSATION_ID:-unknown}}/marimo-server"
        proxy_args=()
        if [ -n "''${PUBLIC_HOST:-}" ]; then proxy_args+=(--proxy "''${PUBLIC_HOST}"); fi
        ${seedSettings}
        # --no-token: access is gated by the platform proxy, and marimo-pair needs a token-less server.
        ${runner} \
          --host 0.0.0.0 --port ${toString srv.port} \
          --base-url "$base" "''${proxy_args[@]}" \
          --headless --no-token
      ''}";
  };
}
