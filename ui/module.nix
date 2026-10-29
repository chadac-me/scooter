{ config, lib, buildPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages.scooter-ui = lib.mkDefault (buildPkgs.callPackage ./. { });

  scooter.images.agent-sandbox-ui = {
    package = lib.mkDefault (import ./image.nix {
      pkgs = buildPkgs;
      inherit (cfg) n2c;
      ui = buildPkgs.scooter-ui;
      contribManifest = cfg.contribs.uiManifest;
    });
    attr = "ui-image";
    refKey = "ui";
  };
}
