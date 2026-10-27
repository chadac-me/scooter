# Contrib databases: turns each built contrib's `contribs.<name>.db` into the
# platform pieces, so a contrib's own files never write `scooter.db.*` or
# `scooter.postgres.*`.
#
# A contrib database is owned by an existing service role (`db.owner`, else the
# first service the contrib plugs into): roles stay per service, not per contrib.
# Other services listed in a table's writers/readers get table-scoped grants on
# their own roles. DDL and Atlas history live in `<contrib>/sql`.

{ config, lib, ... }:

let
  cfg = config.scooter;
  inherit (lib) mkOption types;

  withDb = lib.filterAttrs (_: c: c.enable && c.db.enable) config.contribs;

  ownerOf = name: c:
    let hosts = lib.filter (s: c.services.${s}.enable) [ "broker" "webhooks" ]; in
    if c.db.owner != null then c.db.owner
    else if hosts == [ ]
    then throw "contribs.${name}.db: the contrib plugs into no service, so set db.owner to the service whose role owns its database."
    else builtins.head hosts;

  # Services that get CONTRIB_<NAME>_DB_NAME. A grant to any other service would
  # leave it unable to find the database, so it is refused.
  wired = [ "agent-host" "broker" "webhooks" "scheduler" "conversation-router" "conversation-controller" ];

  # Non-owner services and the tables each may read (readers) or write (writers).
  grantsOf = name: c: owner:
    let
      others = lib.unique (lib.concatLists (lib.mapAttrsToList
        (_: t: lib.filter (s: s != owner) (t.writers ++ t.readers)) c.db.tables));
      tablesWhere = svc: field: lib.attrNames (lib.filterAttrs
        (_: t: builtins.elem svc t.${field}) c.db.tables);
      check = svc:
        if builtins.elem svc wired then svc
        else throw ("contribs.${name}.db: ${svc} cannot be granted access; services that "
          + "can reach a contrib database: ${lib.concatStringsSep ", " wired}.");
    in
    map (svc: {
      service = check svc;
      grant = {
        db = c.db.name;
        # A writer implies read, so writers are not repeated as readers.
        tables = lib.subtractLists (tablesWhere svc "writers") (tablesWhere svc "readers");
        writeTables = tablesWhere svc "writers";
      };
    }) others;

  envName = name: "CONTRIB_${lib.toUpper (builtins.replaceStrings [ "-" ] [ "_" ] name)}_DB_NAME";

  # The paths below are fixed so the module system never has to evaluate
  # `config.contribs` to learn which options this module defines.
  hosted = lib.mapAttrsToList (name: c:
    let owner = ownerOf name c; in { inherit name c owner; grants = grantsOf name c owner; }) withDb;
  deployed = lib.filter (e: cfg.postgres.consumers ? ${e.owner}) hosted;
  # Every service with access to a deployed contrib database, owner included.
  access = lib.concatMap (e:
    [{ service = e.owner; inherit e; }] ++ map (g: { inherit (g) service; inherit e; }) e.grants) deployed;
in
{
  options.scooter.contribDbEnv = mkOption {
    internal = true;
    readOnly = true;
    type = types.attrsOf (types.listOf (types.attrsOf types.str));
    description = ''
      Per service, the `CONTRIB_<NAME>_DB_NAME` entries for each contrib database it
      can reach. The service connects with its own role and credentials.
    '';
  };

  # Gated on the contrib being BUILT, not on the deployment running it:
  # `just db-generate` renders from bare defaults.
  config.scooter.db = lib.listToAttrs (map
    (e: lib.nameValuePair e.c.db.name {
      owner = e.owner;
      sqlDir = "contrib/${e.name}/sql";
      tables = lib.mapAttrs
        (_: t: { inherit (t) writers readers note copyFrom; })
        e.c.db.tables;
    })
    hosted);

  config.scooter.postgres.databases = lib.listToAttrs (map
    (e: lib.nameValuePair e.c.db.name { owner = e.owner; })
    deployed);

  config.scooter.postgres.grants = lib.zipAttrsWith (_: lib.concatLists)
    (lib.concatMap (e: map (g: { ${g.service} = [ g.grant ]; }) e.grants) deployed);

  config.scooter.contribDbEnv = lib.genAttrs wired (svc: map
    (a: { name = envName a.e.name; value = a.e.c.db.name; })
    (lib.filter (a: a.service == svc) access));
}
