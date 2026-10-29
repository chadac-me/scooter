{ config, lib, scooterPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages = {
    # Without contribs: what the contribs build and test against.
    scooter-broker-base = lib.mkDefault (scooterPkgs.callPackage ./. { });
    scooter-broker = lib.mkDefault (scooterPkgs.callPackage ./. { contribs = cfg.contribBuild.broker; });
  };

  scooter.images.agent-broker = {
    package = lib.mkDefault (import ./image.nix {
      pkgs = scooterPkgs;
      inherit (cfg) n2c imageLayers;
      broker = scooterPkgs.scooter-broker;
    });
    attr = "broker-image";
    refKey = "broker";
  };
}
