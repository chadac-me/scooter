{ config, lib, buildPkgs, ... }:
{
  scooter.packages.scooter-webhooks-lib = lib.mkDefault (buildPkgs.callPackage ./. { });
}
