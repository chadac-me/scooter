{ config, lib, ... }:

let
  cfg = config.scooter.config;
  inherit (cfg) pkgs;
in
{
  scooter.packages.scooter-ui = lib.mkDefault (pkgs.callPackage ./. { });

  scooter.images.agent-sandbox-ui = {
    package = lib.mkDefault (import ./image.nix {
      inherit pkgs;
      inherit (cfg) n2c;
      ui = pkgs.scooter-ui;
      contribManifest = cfg.contribBuild.uiManifest;
    });
    attr = "ui-image";
    refKey = "ui";
  };
}
