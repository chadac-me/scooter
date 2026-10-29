{ config, lib, ... }:

let
  cfg = config.scooter.config;
  inherit (cfg) pkgs;
in
{
  scooter.packages.scooter-byoc-controller = lib.mkDefault (pkgs.callPackage ./. { });

  scooter.images.byoc-controller = {
    package = lib.mkDefault (import ./image.nix {
      inherit pkgs;
      inherit (cfg) n2c imageLayers;
      byocController = pkgs.scooter-byoc-controller;
    });
    attr = "byoc-controller-image";
    refKey = "byocController";
  };
}
