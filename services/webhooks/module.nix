{ config, lib, ... }:

let
  cfg = config.scooter.config;
  inherit (cfg) pkgs;
in
{
  scooter.packages = {
    # Without contribs: what the contribs build and test against.
    scooter-webhooks-base = lib.mkDefault (pkgs.callPackage ./. { });
    scooter-webhooks = lib.mkDefault (pkgs.callPackage ./. { contribs = cfg.contribBuild.webhooks; });
  };

  scooter.images.agent-webhooks = {
    package = lib.mkDefault (import ./image.nix {
      inherit pkgs;
      inherit (cfg) n2c imageLayers;
      webhooks = pkgs.scooter-webhooks;
    });
    attr = "webhooks-image";
    refKey = "webhooks";
  };
}
