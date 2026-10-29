{ config, lib, buildPkgs, ... }:
{
  # Generated SQLAlchemy models for the shared databases.
  scooter.packages.scooter-schema = lib.mkDefault (buildPkgs.callPackage ./. { });
}
