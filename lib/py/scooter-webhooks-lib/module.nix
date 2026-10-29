{ config, lib, scooterPkgs, ... }:
{
  scooter.packages.scooter-webhooks-lib = lib.mkDefault (scooterPkgs.callPackage ./. { });
}
