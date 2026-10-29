{ config, lib, ... }:

let
  cfg = config.scooter.config;
  inherit (cfg) pkgs;
in
{
  scooter.packages = {
    scooter-warm-store-controller = lib.mkDefault (pkgs.callPackage ./. { });
    # One warm-store benchmark round, for the `bench` CI job.
    scooter-bench-warm-store = lib.mkDefault (pkgs.callPackage ./bench { });
  };

  scooter.images.warm-store-controller = {
    package = lib.mkDefault (import ./image.nix {
      inherit pkgs;
      inherit (cfg) n2c imageLayers;
      warmStoreController = pkgs.scooter-warm-store-controller;
    });
    attr = "warm-store-controller-image";
    refKey = "warmStoreController";
  };
}
