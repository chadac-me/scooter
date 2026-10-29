{ config, lib, scooterPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages.scooter-byoc-controller = lib.mkDefault (scooterPkgs.callPackage ./. { });

  scooter.images.byoc-controller = {
    package = lib.mkDefault (import ./image.nix {
      pkgs = scooterPkgs;
      inherit (cfg) n2c imageLayers;
      byocController = scooterPkgs.scooter-byoc-controller;
    });
    attr = "byoc-controller-image";
    refKey = "byocController";
  };
}
