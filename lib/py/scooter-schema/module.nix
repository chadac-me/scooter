{ config, lib, ... }:
{
  # Generated SQLAlchemy models for the shared databases.
  scooter.packages.scooter-schema = lib.mkDefault (config.scooter.config.pkgs.callPackage ./. { });
}
