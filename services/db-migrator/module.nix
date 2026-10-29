{ config, lib, scooterPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  # The shared-database migration Job.
  scooter.images.agent-db-migrator = {
    package = lib.mkDefault (import ./image.nix {
      inherit lib;
      inherit (cfg) n2c;
      pkgs = scooterPkgs;
      contribSqlDirs = cfg.contribBuild.sqlDirs;
    });
    attr = "db-migrator-image";
    refKey = "dbMigrator";
  };
}
