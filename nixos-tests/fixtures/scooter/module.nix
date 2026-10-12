# A fixture `.scooter/module.nix` standing in for a deployment's injected NixOS
# module: it declares a tool and a systemd service, so the runtime converge is
# shown to apply both from a mounted module. An injected module's package is
# built eagerly during the switch.
{ config, pkgs, lib, ... }:
{
  # The module declares its own tool.
  environment.systemPackages = [
    (pkgs.writeShellScriptBin "scooter-demo" ''exec ${pkgs.hello}/bin/hello "$@"'')
  ];

  # A systemd service the injected module adds.
  systemd.services.scooter-demo-service = {
    description = "Injected demo service (proves .scooter module services apply)";
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${pkgs.coreutils}/bin/true";
    };
  };
}
