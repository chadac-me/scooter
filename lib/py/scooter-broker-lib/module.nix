{ config, lib, ... }:
{
  scooter.packages.scooter-broker-lib = lib.mkDefault (config.scooter.config.pkgs.callPackage ./. { });
}
