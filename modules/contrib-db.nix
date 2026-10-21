# Contrib databases: turns each built contrib's `contribs.<name>.db` into the
# platform pieces, so a contrib's own files never write `scooter.db.*` or
# `scooter.postgres.*`.
#
# A contrib database is owned by its HOST service's existing role (the first
# service the contrib plugs into): roles stay per service, not per contrib. Its
# DDL and Atlas history live in `<contrib>/sql`, so its migrations never touch a
# core database's.

{ config, lib, ... }:

let
  cfg = config.scooter;

  withDb = lib.filterAttrs (_: c: c.enable && c.db.enable) config.contribs;

  hostOf = name: c:
    let hosts = lib.filter (s: c.services.${s}.enable) [ "broker" "webhooks" ]; in
    if hosts == [ ]
    then throw "contribs.${name}.db: the contrib plugs into no service, so nothing can own its database."
    else builtins.head hosts;

  # Grants to a second service's role are not implemented yet; refuse rather than
  # render a spec the postgres grants do not honour.
  checkTables = name: c: host:
    let
      others = lib.unique (lib.concatLists (lib.mapAttrsToList
        (_: t: lib.filter (s: s != host) (t.writers ++ t.readers)) c.db.tables));
    in
    if others == [ ] then c.db.tables
    else throw ("contribs.${name}.db: ${lib.concatStringsSep ", " others} would need access "
      + "to a database owned by ${host}; cross-service grants on contrib databases are not supported yet.");

  envName = name: "CONTRIB_${lib.toUpper (builtins.replaceStrings [ "-" ] [ "_" ] name)}_DB_NAME";

  # The paths below are fixed so the module system never has to evaluate
  # `config.contribs` to learn which options this module defines.
  hosted = lib.mapAttrsToList (name: c: { inherit name c; host = hostOf name c; }) withDb;
  deployed = lib.filter (e: cfg.${e.host}.enable or false) hosted;
  envFor = svc: map (e: { name = envName e.name; value = e.c.db.name; })
    (lib.filter (e: e.host == svc) deployed);
in
{
  # Gated on the contrib being BUILT, not on the deployment running it:
  # `just db-generate` renders from bare defaults.
  config.scooter.db = lib.listToAttrs (map
    (e: lib.nameValuePair e.c.db.name {
      owner = e.host;
      sqlDir = "contrib/${e.name}/sql";
      tables = lib.mapAttrs
        (_: t: { inherit (t) writers readers note copyFrom; })
        (checkTables e.name e.c e.host);
    })
    hosted);

  config.scooter.postgres.databases = lib.listToAttrs (map
    (e: lib.nameValuePair e.c.db.name { owner = e.host; })
    deployed);

  config.scooter.broker.extraEnv = envFor "broker";
  config.scooter.webhooks.extraEnv = envFor "webhooks";
}
