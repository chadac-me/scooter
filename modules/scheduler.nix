# Scheduler: Deployment, Service and ServiceAccount. It fires cron-scheduled
# tasks by POSTing each run's prompt to the agent-host /agui as a fresh
# conversation, presenting a projected SA token (audience agent-host) so the
# agent-host honors the task `owner`. State lives in the scheduler's own
# database on the shared platform Postgres.

{ config, lib, ... }:

let
  cfg = config.scooter;
  scfg = cfg.scheduler;
in
{
  options.scooter.scheduler = with lib; {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Deploy the scheduled-tasks service (cron-spawns conversations).";
    };
    image = mkOption {
      type = types.str;
      default = cfg.images.agent-scheduler.ref.fullUrl;
      defaultText = literalExpression "config.scooter.images.agent-scheduler.ref.fullUrl";
      description = "OCI ref of the scheduler image.";
    };
    tickSeconds = mkOption {
      type = types.int;
      default = 30;
      description = "How often the scheduler loop checks for due tasks.";
    };
    runRetentionDays = mkOption {
      type = types.int;
      default = 90;
      description = "TTL for task_runs in days; 0 disables the sweep (no DELETE).";
    };
    relayKey = mkOption {
      type = types.str;
      default = "";
      description = ''
        API key gating the /tasks API (Bearer). Empty = auth disabled (local only).
        For a real deploy, set via a Secret + envFrom, not inline.
      '';
    };
    logLevel = mkOption {
      type = types.str;
      default = "INFO";
      example = "DEBUG";
      description = "Root log level (LOG_LEVEL) — INFO logs task fires/spawns; DEBUG is verbose.";
    };
  };

  # The table declarations are unconditional (see modules/db-spec.nix); everything else is gated on `enable`.
  config = lib.mkMerge [

  # The tables the `scheduler` database holds.
  {
    scooter.db.scheduler = {
      owner = "scheduler";
      tables = {
        scheduled_tasks = { writers = [ "scheduler" ]; };
        task_runs = { writers = [ "scheduler" ]; };
      };
    };
  }
  (lib.mkIf scfg.enable {
    kubernetes.resources = {
      serviceAccounts.agent-scheduler = {
        metadata = { name = "agent-scheduler"; namespace = cfg.namespace; };
      };

      deployments.agent-scheduler = {
        metadata = { name = "agent-scheduler"; namespace = cfg.namespace; };
        spec = {
          # Multiple replicas are safe because claim_due advances next_run_at under FOR UPDATE SKIP LOCKED.
          replicas = cfg.statelessReplicas;
          selector.matchLabels.app = "agent-scheduler";
          template = {
            metadata.labels.app = "agent-scheduler";
            spec = {
              serviceAccountName = "agent-scheduler";
              containers.agent-scheduler = {
                name = "agent-scheduler";
                image = scfg.image;
                imagePullPolicy = cfg.pullPolicy;
                command = [ "agent-scheduler" ];
                resources = lib.mkDefault {
                  requests = { cpu = "50m"; memory = "128Mi"; };
                  limits = { memory = "512Mi"; };
                };
                ports = [{ containerPort = 8080; name = "http"; }];
                env = [
                  { name = "AGENT_HOST_URL"; value = "http://agent-host.${cfg.namespace}.svc.cluster.local:8080"; }
                  { name = "TICK_SECONDS"; value = toString scfg.tickSeconds; }
                  { name = "RUN_RETENTION_DAYS"; value = toString scfg.runRetentionDays; }
                  { name = "SA_TOKEN_PATH"; value = "/var/run/secrets/agent-host/token"; }
                  { name = "LOG_LEVEL"; value = scfg.logLevel; }
                ] ++ lib.optional (scfg.relayKey != "") { name = "RELAY_KEY"; value = scfg.relayKey; }
                ++ lib.optionals cfg.observability.otel.enable ([
                  # The OTLP endpoint and headers come from the standard OTEL_EXPORTER_OTLP_* env.
                  { name = "OTEL_METRICS_ENABLED"; value = "1"; }
                  { name = "OTEL_SERVICE_NAME"; value = "agent-scheduler"; }
                ] ++ lib.mapAttrsToList (k: v: { name = k; value = v; }) cfg.observability.otel.env)
                # The DSN is assembled app-side from these parts.
                ++ [
                  { name = "DB_HOST"; value = cfg.postgres.host; }
                  { name = "DB_PORT"; value = toString cfg.postgres.port; }
                  { name = "DB_USER"; value = "scheduler"; }
                  { name = "DB_NAME"; value = "scheduler"; }
                  { name = "DB_PASSWORD"; valueFrom.secretKeyRef = { name = "agent-pg-scheduler"; key = "password"; }; }
                ] ++ lib.optional (cfg.postgres.sslmode != null) { name = "DB_SSLMODE"; value = cfg.postgres.sslmode; };
                volumeMounts = [
                  { name = "data"; mountPath = "/data"; }
                  # Projected SA token (audience agent-host) for /agui owner trust.
                  { name = "agent-host-token"; mountPath = "/var/run/secrets/agent-host"; readOnly = true; }
                ];
                readinessProbe.httpGet = { path = "/healthz"; port = "http"; };
                livenessProbe.httpGet = { path = "/healthz"; port = "http"; };
              };
              volumes = [
                { name = "data"; emptyDir = { }; }
                {
                  name = "agent-host-token";
                  projected.sources = [{
                    serviceAccountToken = { audience = "agent-host"; path = "token"; expirationSeconds = 3600; };
                  }];
                }
              ];
            };
          };
        };
      };

      services.agent-scheduler = {
        metadata = { name = "agent-scheduler"; namespace = cfg.namespace; };
        spec = {
          selector.app = "agent-scheduler";
          ports = [{ port = 8080; targetPort = "http"; name = "http"; }];
        };
      };
    };

    # The provisioning Job creates the `scheduler` database and role (secret agent-pg-scheduler).
    scooter.postgres.consumers.scheduler = { db = "scheduler"; user = "scheduler"; };
  })
  ];
}
