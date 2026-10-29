{ config, lib, scooterPkgs, ... }:
{
  scooter.packages.scooter-broker-lib = lib.mkDefault (scooterPkgs.callPackage ./. { });
}
