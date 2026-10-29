{ pkgs, lib, n2c, contribSqlDirs ? { } }:

# OCI image for the shared-database migration Job (modules/db-migrate.nix): the
# Atlas CLI, the migrations from lib/sql plus each shipped contrib's own `sql/`,
# and a driver that applies them to each database, adopting a pre-Atlas baseline
# where needed. Safe to run every deploy.

let
  inherit (import ./migrator.nix { inherit pkgs lib contribSqlDirs; }) runScript;

  image = n2c.buildImage {
    name = "agent-db-migrator";
    tag = "latest";
    # Splitting the closure keeps app pushes small.
    maxLayers = 60;
    copyToRoot = pkgs.buildEnv {
      name = "db-migrator-root";
      paths = [ runScript pkgs.atlas pkgs.bashInteractive pkgs.coreutils pkgs.cacert ];
      pathsToLink = [ "/bin" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${runScript}/bin/agent-db-migrate" ];
      Env = [ "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt" ];
    };
  };
in
image
