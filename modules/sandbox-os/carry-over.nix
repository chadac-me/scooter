# The broker tooling in the sandbox image: agent-broker on PATH, and a oneshot that
# drops the `broker` git credential helper older images wrote (git is authenticated
# by the forge proxy, modules/sandbox-os/forge-proxy.nix). The pod env (HOME, BROKER_URL,
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

    # The workspace PVC keeps .gitconfig across restarts, so a helper an older image set
    # would outlive git-credential-broker; --file targets the agent's HOME, not /root.
    systemd.services.scooter-git-broker = {
      description = "Remove the legacy git credential helper -> broker";
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        gitconfig=${lib.escapeShellArg "${cfg.home}/.gitconfig"}
        if [ -e "$gitconfig" ]; then
          ${pkgs.git}/bin/git config --file "$gitconfig" --unset-all credential.helper '^broker$' || true
        fi
      '';
    };
  };
}
