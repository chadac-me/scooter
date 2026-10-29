{ config, lib, buildPkgs, ... }:
{
  # The generated @scooter/schema package: Drizzle tables plus guards.
  scooter.packages.scooter-schema-js = lib.mkDefault (buildPkgs.callPackage ./. { });
}
