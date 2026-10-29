{ config, lib, scooterPkgs, ... }:
{
  # @scooter/svcauth: ServiceAccount token auth shared by the TS services.
  scooter.packages.scooter-svcauth-js = lib.mkDefault (scooterPkgs.callPackage ./. { });
}
