{ config, lib, scooterPkgs, ... }:
{
  scooter.packages.scooter-claude-sdk-provider = lib.mkDefault (scooterPkgs.callPackage ./. { });
}
