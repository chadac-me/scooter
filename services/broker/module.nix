{ config, lib, ... }:

let
  cfg = config.scooter.config;
  inherit (cfg) pkgs;
in
{
  scooter.packages = {
    # Without contribs: what the contribs build and test against.
    scooter-broker-base = lib.mkDefault (pkgs.callPackage ./. { });
    scooter-broker = lib.mkDefault (pkgs.callPackage ./. { contribs = cfg.contribBuild.broker; });
  };

  scooter.images.agent-broker = {
    package = lib.mkDefault (import ./image.nix {
      inherit pkgs;
      inherit (cfg) n2c imageLayers;
      broker = pkgs.scooter-broker;
    });
    attr = "broker-image";
    refKey = "broker";
  };
}
