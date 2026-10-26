# The broker tooling in the sandbox image: the broker tools (agent-broker,
# git-credential-broker) as packages on PATH, and a oneshot that points git's
# credential helper at the broker at boot. The pod env (HOME, BROKER_URL,
# BROKER_TOKEN_PATH) and the token mount are set by the provisioner; these
# units only consume them. `home` is also read by contrib/aws/sandbox.nix.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.scooterCarryOver;

  # callPackage'd directly rather than via nixpkgs.overlays, which conflicts with the nixosTest framework's nixpkgs.pkgs.
  brokerTools = pkgs.callPackage ../../pkgs/broker-tools { };
in
{
  options.programs.scooterCarryOver = {
    enable = lib.mkEnableOption "the broker/git carry-over from the legacy sandbox image";

    # systemd PID 1 resets its own HOME to /root, so boot-time units target this path directly.
    home = lib.mkOption {
      type = lib.types.str;
      default = "/workspace";
      description = "The HOME the agent-host execs with — where git/aws config is written.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = brokerTools.all ++ [ pkgs.git ];

    # Points git's credential helper at the broker, best-effort, once the broker URL is known.
    systemd.services.scooter-git-broker = {
      description = "Configure git credential helper -> broker";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      # BROKER_URL is read from PID 1's environ, and --file targets the agent's HOME where --global would hit /root.
      script = ''
        broker_url=$(tr '\0' '\n' < /proc/1/environ | sed -n 's/^BROKER_URL=//p' | head -1 || true)
        # With the forge proxy (forge-proxy.nix) git needs no helper, and the broker no longer vends one; the
        # workspace PVC keeps .gitconfig across restarts, so an earlier `broker` helper is removed.
        if [ -s /etc/scooter/forge-ca/ca.crt ]; then
          ${pkgs.git}/bin/git config --file ${lib.escapeShellArg "${cfg.home}/.gitconfig"} --unset-all credential.helper '^broker$' || true
          echo "forge proxy present; no git credential helper"
        elif [ -n "$broker_url" ]; then
          mkdir -p ${lib.escapeShellArg cfg.home}
          ${pkgs.git}/bin/git config --file ${lib.escapeShellArg "${cfg.home}/.gitconfig"} credential.helper broker || true
          echo "git credential helper -> broker ($broker_url) in ${cfg.home}/.gitconfig"
        fi
      '';
    };
  };
}
