{ config, lib, scooterPkgs, ... }:
{
  # Generated SQLAlchemy models for the shared databases.
  scooter.packages.scooter-schema = lib.mkDefault (scooterPkgs.callPackage ./. { });
}
