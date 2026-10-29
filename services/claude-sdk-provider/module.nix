{ config, lib, ... }:
{
  scooter.packages.scooter-claude-sdk-provider = lib.mkDefault (config.scooter.config.pkgs.callPackage ./. { });
}
