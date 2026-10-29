{ config, lib, scooterPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages = {
    # Without contribs: what the contribs build and test against.
    scooter-webhooks-base = lib.mkDefault (scooterPkgs.callPackage ./. { });
    scooter-webhooks = lib.mkDefault (scooterPkgs.callPackage ./. { contribs = cfg.contribBuild.webhooks; });
  };

  scooter.images.agent-webhooks = {
    package = lib.mkDefault (import ./image.nix {
      pkgs = scooterPkgs;
      inherit (cfg) n2c imageLayers;
      webhooks = scooterPkgs.scooter-webhooks;
    });
    attr = "webhooks-image";
    refKey = "webhooks";
  };
}
