{ config, lib, scooterPkgs, ... }:
{
  # The generated @scooter/schema package: Drizzle tables plus guards.
  scooter.packages.scooter-schema-js = lib.mkDefault (scooterPkgs.callPackage ./. { });
}
