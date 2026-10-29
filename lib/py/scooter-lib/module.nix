{ config, lib, buildPkgs, ... }:
{
  scooter.packages.scooter-lib = lib.mkDefault (buildPkgs.callPackage ./. { });
}
