{ config, lib, ... }:
{
  scooter.packages.scooter-webhooks-lib = lib.mkDefault (config.scooter.config.pkgs.callPackage ./. { });
}
