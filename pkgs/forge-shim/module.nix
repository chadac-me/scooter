{ config, lib, ... }:
{
  # The sandbox's local forge proxy shim.
  scooter.packages.scooter-forge-shim = lib.mkDefault (config.scooter.config.pkgs.callPackage ./. { });
}
