{ config, lib, ... }:
{
  scooter.packages.scooter-lib = lib.mkDefault (config.scooter.config.pkgs.callPackage ./. { });
}
