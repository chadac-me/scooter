# files' deployment half, reading contribs.files.
#
# `{ config, lib, ... }` only, and nothing built: an external deployer imports
# modules/platform.nix with no `pkgs`, so forcing a package here is an eval error.
{ config, lib, ... }:

let
  bcfg = config.scooter.broker;
  ccfg = config.contribs.files;
in
{
  config = lib.mkMerge [
    # Gated on the contrib being BUILT rather than on this deployment running the
    # store: `just db-generate` renders owners.toml from bare defaults, and
    # ownership.spec.ts requires it to list exactly the tables schema.sql defines —
    # so a declaration that also tracked `annotations.enable` would drop the row
    # while the DDL stayed, and fail that check. Same rule as contrib/aws.
    (lib.mkIf ccfg.enable {
      # Writer is `broker`, since this contrib runs inside the broker image through
      # the broker's own database role, and the owner is modules/broker.nix's.
      scooter.db.broker.tables.annotations = { writers = [ "broker" ]; };
    })

    # The provider's env, gated on the broker being deployed as well as files.
    (lib.mkIf (bcfg.enable && ccfg.enable && ccfg.annotations.enable) {
      scooter.broker.extraEnv = [
        # Annotations reach the shared `broker` database through the BROKER_DB_*
        # components the broker already passes every provider, so there is no DSN here.
        { name = "FILES_ANNOTATIONS_ENABLED"; value = "true"; }
        # Storing an annotation wakes its conversation, at the platform's one
        # cluster-internal agent-host URL.
        { name = "FILES_AGENT_HOST_URL"; value = bcfg.agentHostUrl; }
      ];
    })
  ];
}
