{ config, lib, ... }:
{
  # The generated @scooter/schema package: Drizzle tables plus guards.
  scooter.packages.scooter-schema-js = lib.mkDefault (config.scooter.config.pkgs.callPackage ./. { });
}
