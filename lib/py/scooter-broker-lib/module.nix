{ config, lib, buildPkgs, ... }:
{
  scooter.packages.scooter-broker-lib = lib.mkDefault (buildPkgs.callPackage ./. { });
}
