{ config, lib, buildPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  # The shared-database migration Job.
  scooter.images.agent-db-migrator = {
    package = lib.mkDefault (import ./image.nix {
      inherit lib;
      inherit (cfg) n2c;
      pkgs = buildPkgs;
      contribSqlDirs = cfg.contribs.sqlDirs;
    });
    attr = "db-migrator-image";
    refKey = "dbMigrator";
  };
}
