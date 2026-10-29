{ config, lib, scooterPkgs, ... }:
{
  scooter.packages.scooter-lib = lib.mkDefault (scooterPkgs.callPackage ./. { });
}
