# Shared-database migration Job: applies the Atlas migrations under lib/sql to
# the per-service databases on deploy.
#
# The agent-db-migrator image runs `atlas migrate apply --baseline` against each
# database, connecting as that database's own consumer role. A `wait-for-db`
# initContainer gates it on agent-postgres-init having created those databases
# and roles, and the Job's name hashes its spec because a pod template is
# immutable.

{ config, lib, kubenix, ... }:

let
  cfg = config.scooter;
  mcfg = cfg.dbMigrate;
  pcfg = cfg.postgres;
  ns = cfg.namespace;

  # Consumer keys whose database has an Atlas schema; the key names the Secret
  # while `c.db` names the database, role and lib/sql directory.
  enabledKeys = lib.attrNames
    (lib.filterAttrs (_k: c: builtins.elem c.db cfg.dbSpec.databases) pcfg.consumers);
  # key -> the database/role/sql-dir name.
  dbOf = k: pcfg.consumers.${k}.db;
  # The env var the migrator script looks up, mirroring its own
  # `tr '[:lower:]-' '[:upper:]_'`.
  pwEnvOf = db: "${lib.toUpper (builtins.replaceStrings [ "-" ] [ "_" ] db)}_DB_PASSWORD";
  # A shell reference to that var, since BusyBox ash has no `${"$"}{!var}` indirection.
  pwRefOf = db: "$" + pwEnvOf db;

  # The password env shared by the gate initContainer and the migrator.
  pwEnv = map
    (k: {
      name = pwEnvOf (dbOf k);
      valueFrom.secretKeyRef = { name = "agent-pg-${k}"; key = "password"; };
    })
    enabledKeys;

  # Waits for each database and role to exist with a real connect as the role the
  # migrator itself uses.
  waitScript = ''
    set -eu
  '' + lib.optionalString (pcfg.sslmode != null) ''
    export PGSSLMODE="${pcfg.sslmode}"
  '' + lib.concatMapStrings
    (k:
      let db = dbOf k; in ''
        echo "[${db}] waiting for database + role ..."
        n=0
        until PGPASSWORD="${pwRefOf db}" psql -h "${pcfg.host}" -p "${toString pcfg.port}" \
          -U "${db}" -d "${db}" -tAc 'SELECT 1' >/dev/null 2>&1; do
          n=$((n + 1))
          if [ "$n" -ge 150 ]; then
            echo "[${db}] still unreachable after $n attempts (~5m) — giving up" >&2
            exit 1
          fi
          sleep 2
        done
        echo "[${db}] ready"
      '')
    enabledKeys + ''
    echo "all target databases reachable"
  '';

  # Stable identity for selectors and logs, independent of the hashed name.
  jobLabels = {
    "app.kubernetes.io/name" = "agent-db-migrate";
    "app.kubernetes.io/component" = "migration";
  };

  jobSpec = {
    # Retries only cover a genuinely failing migration.
    backoffLimit = 3;
    # Reap a superseded Job after a day, leaving time to read its logs.
    ttlSecondsAfterFinished = 86400;
    template = {
      metadata.labels = jobLabels;
      spec = {
        restartPolicy = "OnFailure";
        # The postgres image carries the psql client the gate needs.
        initContainers = [{
          name = "wait-for-db";
          image = pcfg.image;
          command = [ "/bin/sh" "-c" waitScript ];
          env = pwEnv;
        }];
        containers.migrate = {
          name = "migrate";
          image = mcfg.image;
          imagePullPolicy = cfg.pullPolicy;
          env = [
            { name = "DB_HOST"; value = pcfg.host; }
            { name = "DB_PORT"; value = toString pcfg.port; }
            { name = "DB_ENVS"; value = lib.concatStringsSep " " (map dbOf enabledKeys); }
          ]
          ++ lib.optional (pcfg.sslmode != null) { name = "DB_SSLMODE"; value = pcfg.sslmode; }
          # The var name derives from the db name and the Secret from the consumer key.
          ++ pwEnv;
        };
      };
    };
  };

  # A Job's spec.template is immutable, so hashing makes a spec change a create
  # while an unchanged spec keeps its name.
  jobName = kubenix.lib.k8s.mkNameHash { name = "agent-db-migrate"; data = jobSpec; };
in
{
  options.scooter.dbMigrate = with lib; {
    enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Run the shared-database migration Job on deploy (applies lib/sql migrations
        via Atlas). Only databases with an Atlas schema that are also provisioned
        (a postgres consumer) are migrated; with none, no Job is rendered.
      '';
    };
    image = mkOption {
      type = types.str;
      default = cfg.images.agent-db-migrator.ref.fullUrl;
      defaultText = literalExpression "config.scooter.images.agent-db-migrator.ref.fullUrl";
      description = "OCI ref of the db-migrator image.";
    };
  };

  config = lib.mkMerge [
    (lib.mkIf (mcfg.enable && enabledKeys != [ ]) {
    # The Nix attr name stays fixed (it is what other modules would reference);
    # metadata.name is the hashed one that actually lands in the cluster.
    kubernetes.resources.jobs.agent-db-migrate = {
      metadata = {
        name = jobName;
        namespace = ns;
        labels = jobLabels;
        annotations."agent-sandbox/migrates" = lib.concatStringsSep "," (map dbOf enabledKeys);
      };
      spec = jobSpec;
    };
  })
  ];
}
