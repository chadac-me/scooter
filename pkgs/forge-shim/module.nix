{ config, lib, buildPkgs, ... }:
{
  # The sandbox's local forge proxy shim.
  scooter.packages.scooter-forge-shim = lib.mkDefault (buildPkgs.callPackage ./. { });
}
