# files' deployment half: the legacy broker copy of its table.
#
# `{ config, lib, ... }` only, and nothing built: an external deployer imports
# modules/platform.nix with no `pkgs`, so forcing a package here is an eval error.
{ config, lib, ... }:

{
  # Gated on the contrib being BUILT rather than on this deployment running the
  # store: `just db-generate` renders owners.toml from bare defaults, and
  # ownership.spec.ts requires it to list exactly the tables schema.sql defines —
  # so a declaration that also tracked `annotations.enable` would drop the row
  # while the DDL stayed, and fail that check. Same rule as contrib/aws.
  config = lib.mkIf config.contribs.files.enable {
    # Writer is `broker`, since this contrib runs inside the broker image through
    # the broker's own database role, and the owner is modules/broker.nix's.
    # LEGACY: the table now lives in contrib_files (contrib.nix `db`). The broker
    # copy stays declared while any deployment still has it (until every one has set
    # scooter.dbMigrate.retireCopiedTables); then this row and `copyFrom` go together.
    scooter.db.broker.tables.annotations = { writers = [ "broker" ]; };
  };
}
