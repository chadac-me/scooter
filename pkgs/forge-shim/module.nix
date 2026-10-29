{ config, lib, scooterPkgs, ... }:
{
  # The sandbox's local forge proxy shim.
  scooter.packages.scooter-forge-shim = lib.mkDefault (scooterPkgs.callPackage ./. { });
}
