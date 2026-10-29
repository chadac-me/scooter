{ config, lib, buildPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages = {
    scooter-warm-store-controller = lib.mkDefault (buildPkgs.callPackage ./. { });
    # One warm-store benchmark round, for the `bench` CI job.
    scooter-bench-warm-store = lib.mkDefault (buildPkgs.callPackage ./bench { });
  };

  scooter.images.warm-store-controller = {
    package = lib.mkDefault (import ./image.nix {
      pkgs = buildPkgs;
      inherit (cfg) n2c imageLayers;
      warmStoreController = buildPkgs.scooter-warm-store-controller;
    });
    attr = "warm-store-controller-image";
    refKey = "warmStoreController";
  };
}
