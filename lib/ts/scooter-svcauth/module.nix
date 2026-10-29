{ config, lib, ... }:
{
  # @scooter/svcauth: ServiceAccount token auth shared by the TS services.
  scooter.packages.scooter-svcauth-js = lib.mkDefault (config.scooter.config.pkgs.callPackage ./. { });
}
