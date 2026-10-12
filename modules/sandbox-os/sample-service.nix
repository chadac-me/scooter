# A minimal sample systemd service proving the systemd path end-to-end: it reaches
# `active`, opens a TCP port, and the agent can `systemctl start/stop` it.

{ config, lib, pkgs, ... }:

let
  cfg = config.services.sampleDevService;
in
{
  options.services.sampleDevService = {
    enable = lib.mkEnableOption "the PoC sample dev service (proves the systemd path)";

    port = lib.mkOption {
      type = lib.types.port;
      default = 8888;
      description = "TCP port the sample service listens on.";
    };
  };

  config = lib.mkIf cfg.enable {
    # Python's stdlib http.server, so there is no app code to ship.
    systemd.services.sample-dev-service = {
      description = "PoC sample dev service (HTTP on ${toString cfg.port})";
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        ExecStart = "${pkgs.python3}/bin/python3 -m http.server ${toString cfg.port} --bind 0.0.0.0";
        DynamicUser = true;
        Restart = "on-failure";
      };
    };
  };
}
