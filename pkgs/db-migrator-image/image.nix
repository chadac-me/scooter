{ pkgs, lib, n2c, ... }:

# OCI image for the shared-database migration Job (modules/db-migrate.nix): the
# Atlas CLI, the migrations from lib/sql, and a driver that applies them to each
# per-service database, adopting a pre-Atlas baseline where needed. Safe to run
# every deploy.

let
  # The migration payload, copied so the image carries exactly what is under lib/sql.
  sqlPayload = pkgs.runCommandNoCC "scooter-sql" { } ''
    mkdir -p "$out"
    cp -r ${../../lib/sql}/. "$out/"
  '';

  runScript = pkgs.writeShellApplication {
    name = "agent-db-migrate";
    # apply_env greps for "not clean".
    runtimeInputs = [ pkgs.atlas pkgs.coreutils pkgs.gnugrep ];
    text = ''
      # SQL_DIR defaults to the baked migrations; overridable for local runs.
      SQL_DIR="''${SQL_DIR:-${sqlPayload}}"
      : "''${DB_HOST:?DB_HOST required}" "''${DB_PORT:?DB_PORT required}" "''${DB_ENVS:?DB_ENVS required}"
      SSL="''${DB_SSLMODE:-disable}"

      # Plain apply handles a fresh or Atlas-managed DB; a pre-Atlas DB reports "not
      # clean" and is re-applied with --baseline, and any other failure is surfaced
      # so the caller retries.
      apply_env() {
        local dir="$1" url="$2" ver="$3" out
        if out="$(atlas migrate apply --dir "$dir" --url "$url" 2>&1)"; then
          printf '%s\n' "$out" | tail -1
          return 0
        fi
        if [ -n "$ver" ] && printf '%s' "$out" | grep -q "not clean"; then
          atlas migrate apply --dir "$dir" --url "$url" --baseline "$ver"
          return $?
        fi
        printf '%s\n' "$out" >&2
        return 1
      }

      # Each env's database and role share the env's name, and its password arrives
      # as <ENV>_DB_PASSWORD.
      for env in $DB_ENVS; do
        pwvar="$(printf '%s' "$env" | tr '[:lower:]-' '[:upper:]_')_DB_PASSWORD"
        pw="''${!pwvar:?missing $pwvar}"
        baseline_file=""
        for f in "$SQL_DIR/$env/migrations"/*_baseline.sql; do
          [ -e "$f" ] && baseline_file="$f" && break
        done
        # No baseline just means nothing to adopt; only an empty dir is skipped.
        any_migration=""
        for f in "$SQL_DIR/$env/migrations"/*.sql; do
          [ -e "$f" ] && any_migration="$f" && break
        done
        if [ -z "$any_migration" ]; then
          echo "[$env] no migrations found — skipping"
          continue
        fi
        baseline_version=""
        if [ -n "$baseline_file" ]; then
          baseline_version="$(basename "$baseline_file")"; baseline_version="''${baseline_version%%_*}"
        else
          echo "[$env] no baseline — applying migrations directly (repo-created database)"
        fi
        dir="file://$SQL_DIR/$env/migrations"
        url="postgres://$env:$pw@$DB_HOST:$DB_PORT/$env?sslmode=$SSL"
        echo "[$env] applying migrations"
        # Retry, since the agent-postgres-init Job that creates the database and role
        # has no ordering guarantee relative to this one.
        n=0
        until apply_env "$dir" "$url" "$baseline_version"; do
          n=$((n + 1))
          if [ "$n" -ge 30 ]; then
            echo "[$env] still failing after $n attempts — giving up"
            exit 1
          fi
          echo "[$env] not ready (attempt $n) — retrying in 5s"
          sleep 5
        done
      done
      echo "all migrations applied"
    '';
  };
  image = n2c.buildImage {
    name = "agent-db-migrator";
    tag = "latest";
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
# A kubenix module: this image declares its own scooter.images entry.
{
  config.scooter.images.agent-db-migrator = {
    package = lib.mkDefault image;
    attr = "db-migrator-image";
    refKey = "dbMigrator";
  };
}
