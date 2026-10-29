{ config, lib, scooterPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages = {
    scooter-warm-store-controller = lib.mkDefault (scooterPkgs.callPackage ./. { });
    # One warm-store benchmark round, for the `bench` CI job.
    scooter-bench-warm-store = lib.mkDefault (scooterPkgs.callPackage ./bench { });
  };

  scooter.images.warm-store-controller = {
    package = lib.mkDefault (import ./image.nix {
      pkgs = scooterPkgs;
      inherit (cfg) n2c imageLayers;
      warmStoreController = scooterPkgs.scooter-warm-store-controller;
    });
    attr = "warm-store-controller-image";
    refKey = "warmStoreController";
  };
}
