{ config, lib, ... }:

let
  cfg = config.scooter.config;
in
{
  # The shared-database migration Job.
  scooter.images.agent-db-migrator = {
    package = lib.mkDefault (import ./image.nix {
      inherit lib;
      inherit (cfg) pkgs n2c;
      contribSqlDirs = cfg.contribBuild.sqlDirs;
    });
    attr = "db-migrator-image";
    refKey = "dbMigrator";
  };
}
