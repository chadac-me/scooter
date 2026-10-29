{ config, lib, buildPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages.scooter-byoc-controller = lib.mkDefault (buildPkgs.callPackage ./. { });

  scooter.images.byoc-controller = {
    package = lib.mkDefault (import ./image.nix {
      pkgs = buildPkgs;
      inherit (cfg) n2c imageLayers;
      byocController = buildPkgs.scooter-byoc-controller;
    });
    attr = "byoc-controller-image";
    refKey = "byocController";
  };
}
