{ pkgs, lib, evalPlatform, contribRegistry }:

# Runs the deploy's migrator against a throwaway Postgres for two renders: no
# contribs, and every contrib that owns a database. Each applies the Job's own
# DB_ENVS and DB_COPIES twice (a deploy reruns it), checks every database
# against its schema.sql, then retires the copied tables.

let
  # Every contrib with a database, shipped or not.
  dbContribs = lib.filterAttrs (_: c: c.db.enable) contribRegistry.eval.config.contribs;

  inherit (import ../services/db-migrator/migrator.nix {
    inherit pkgs lib;
    contribSqlDirs = lib.mapAttrs' (_: c: lib.nameValuePair c.db.name (c.src + "/sql")) dbContribs;
  }) runScript sqlPayload;

  # Settings a contrib needs, beyond enable, before it owns a database.
  dbSettings = {
    github.userAuth.enable = true;
    gitlab.userAuth.enable = true;
  };

  # Every core service that owns a database.
  services = {
    broker.enable = true;
    webhooks.enable = true;
    scheduler.enable = true;
    byoc = { enable = true; ingress.enable = false; };
  };

  jobEnv = contribs:
    let
      job = (evalPlatform { module = { scooter = services; inherit contribs; }; })
        .config.kubernetes.resources.jobs.agent-db-migrate;
      env = job.spec.template.spec.containers.migrate.env;
      get = name: (lib.findFirst (e: e.name == name) { value = ""; } env).value;
    in
    { envs = get "DB_ENVS"; copies = get "DB_COPIES"; };

  coreDbs = lib.attrNames (lib.filterAttrs (n: t: t == "directory")
    (builtins.readDir ../lib/sql));
  contribDbs = lib.mapAttrsToList (_: c: c.db.name) dbContribs;

  # Already applied somewhere, so they stay as written.
  bareDropAllowed = [
    "agent_host/migrations/20261015190000_notify_conversation_activity.sql"
    "agent_host/migrations/20261022200100_notify_conversation_turn_state.sql"
    "agent_host/migrations/20261025172400_notify_conversation_visibility.sql"
    "webhooks/migrations/20260921233000_drop_jira_tickets.sql"
  ];

  mkCheck = name: { contribs, expect }:
    let
      job = jobEnv contribs;
      targets = map (s: lib.head (lib.splitString ":" s)) (lib.splitString " " job.envs);
      missing = lib.subtractLists targets expect;
    in
    # A database the render skips would pass untested.
    assert lib.assertMsg (missing == [ ])
      "${name}: the render does not migrate ${lib.concatStringsSep ", " missing}; enable its service in nix/check-db-migrations.nix.";
    pkgs.runCommand name
      {
        nativeBuildInputs = [ runScript pkgs.atlas pkgs.postgresql_16 ];
        DB_ENVS = job.envs;
        DB_COPIES = job.copies;
      } ''
      set -euo pipefail
      export HOME="$TMPDIR" ATLAS_NO_UPDATE_NOTIFIER=1 ATLAS_NO_ANON_TELEMETRY=true

      # A baseline-adopted database never ran the baseline, so a bare DROP fails.
      bare="$(cd ${sqlPayload} && grep -inE '^[[:space:]]*DROP[[:space:]]+(TABLE|INDEX|VIEW|MATERIALIZED[[:space:]]+VIEW|SEQUENCE|TYPE|FUNCTION|TRIGGER)[[:space:]]' */migrations/*.sql \
        | grep -viE 'IF[[:space:]]+EXISTS' \
        | grep -vF ${lib.concatMapStringsSep " " (f: "-e ${lib.escapeShellArg "${f}:"}") bareDropAllowed} || true)"
      if [ -n "$bare" ]; then
        printf '%s\n' "$bare" >&2
        echo "DROP without IF EXISTS in a migration; see nix/check-db-migrations.nix" >&2
        exit 1
      fi
      initdb -D "$TMPDIR/pg" -U postgres --auth=trust >/dev/null
      pg_ctl -D "$TMPDIR/pg" -l "$TMPDIR/pg.log" -w \
        -o "-k $TMPDIR -c listen_addresses=127.0.0.1 -p 5432" start >/dev/null
      trap 'cat "$TMPDIR/pg.log" >&2' ERR
      sql() { psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -qtA "$@"; }

      # What agent-postgres-init provisions: a role per owner, an owned database each.
      for spec in $DB_ENVS; do
        db="''${spec%%:*}"; role="''${spec#*:}"
        if [ -z "$(sql -c "SELECT 1 FROM pg_roles WHERE rolname = '$role'")" ]; then
          sql -c "CREATE ROLE \"$role\" LOGIN PASSWORD 'pw'"
        fi
        sql -c "CREATE DATABASE \"$db\" OWNER \"$role\""
        export "$(printf '%s' "$role" | tr '[:lower:]-' '[:upper:]_')_DB_PASSWORD=pw"
      done
      sql -c 'CREATE DATABASE atlas_dev'

      export DB_HOST=127.0.0.1 DB_PORT=5432 DB_APPLY_ATTEMPTS=1
      echo "== first deploy"
      agent-db-migrate
      echo "== redeploy"
      agent-db-migrate

      for spec in $DB_ENVS; do
        db="''${spec%%:*}"
        diff="$(atlas schema diff \
          --from "postgres://postgres@127.0.0.1:5432/$db?sslmode=disable&search_path=public" \
          --to "file://${sqlPayload}/$db/schema.sql" \
          --dev-url "postgres://postgres@127.0.0.1:5432/atlas_dev?sslmode=disable&search_path=public")"
        if ! printf '%s' "$diff" | grep -q "Schemas are synced"; then
          printf '%s\n' "$diff"
          echo "$db: the migrated database differs from its schema.sql" >&2
          exit 1
        fi
        echo "[$db] matches schema.sql"
      done

      echo "== retire copied tables"
      DB_RETIRE_COPIED=1 agent-db-migrate

      pg_ctl -D "$TMPDIR/pg" -m fast stop >/dev/null
      touch "$out"
    '';
in
{
  db-migrate-no-contribs = mkCheck "db-migrate-no-contribs" {
    contribs = { };
    expect = coreDbs;
  };
  db-migrate-all-contribs = mkCheck "db-migrate-all-contribs" {
    contribs = lib.mapAttrs (n: _: { enable = true; } // dbSettings.${n} or { }) dbContribs;
    expect = coreDbs ++ contribDbs;
  };
}
