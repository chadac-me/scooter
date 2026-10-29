{ config, lib, buildPkgs, ... }:
{
  scooter.packages.scooter-claude-sdk-provider = lib.mkDefault (buildPkgs.callPackage ./. { });
}
