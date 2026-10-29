{ config, lib, scooterPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages.scooter-ui = lib.mkDefault (scooterPkgs.callPackage ./. { });

  scooter.images.agent-sandbox-ui = {
    package = lib.mkDefault (import ./image.nix {
      pkgs = scooterPkgs;
      inherit (cfg) n2c;
      ui = scooterPkgs.scooter-ui;
      contribManifest = cfg.contribBuild.uiManifest;
    });
    attr = "ui-image";
    refKey = "ui";
  };
}
