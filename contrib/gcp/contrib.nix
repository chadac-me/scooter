# What gcp is; its deployment half is ./deployment.nix and its sandbox half ./sandbox.nix.
{ lib, ... }:
let
  clib = import ../lib.nix { inherit lib; };
in
{
  contribs.gcp = { config, ... }: {
    options.serviceAccountSecret = clib.mkSecretOption {
      key = "GCP_SERVICE_ACCOUNT_JSON";
      holds = "the service-account key JSON";
      description = ''
        Secret holding a Google Cloud service-account key (the downloaded JSON
        file). Injected as GCP_SERVICE_ACCOUNT_JSON. The secret must exist in the
        broker namespace.

        With a key, the broker's forge proxy intercepts the Google Cloud API hosts
        and injects a short-lived token minted from it, so `gcloud`, `terraform`
        and `curl` in the sandbox work against the real hostnames while the
        sandbox holds only a placeholder. The service account's IAM roles are
        what the agent may do.
      '';
    };

    options.project = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "my-project";
      description = "Default project for gcloud and terraform in the sandbox; empty sets none.";
    };

    options.scopes = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "https://www.googleapis.com/auth/cloud-platform.read-only" ];
      description = ''
        OAuth scopes to request. Empty requests `cloud-platform`, leaving the
        service account's IAM roles as the only limit. `cloud-platform.read-only`
        makes Google refuse every write, whatever the roles allow.
      '';
    };

    options.extraHosts = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "aiplatform" "us-central1-run.googleapis.com" ];
      description = ''
        googleapis.com hosts to intercept beyond the built-in set (resource
        manager, IAM, Compute, GKE, Cloud Run, Functions, Storage, BigQuery, Cloud
        SQL, Pub/Sub, Secret Manager, KMS, DNS, Monitoring, Logging, Trace, Error
        Reporting and similar). A bare name means `<name>.googleapis.com`. A host
        not intercepted is reached directly, with no credential.
      '';
    };

    options.forgePolicy = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "my_scooter_policies.gcp:policy";
      description = ''
        A `module:attr` naming a ForgePolicy (scooter_broker_lib.forge) the broker
        checks on every Google Cloud request before injecting the token. The
        module must be importable by the broker. Empty (the default) allows
        everything the token allows.
      '';
    };

    config = {
      src = ./.;
      services.broker = {
        enable = true;
        # pyjwt+cryptography sign the RS256 service-account assertion.
        pythonDeps = ps: [ ps.pyjwt ps.cryptography ];
        env = {
          GCP_SERVICE_ACCOUNT_JSON = config.serviceAccountSecret;
          GCP_SCOPES = lib.mkIf (config.scopes != [ ]) (lib.concatStringsSep " " config.scopes);
          GCP_EXTRA_HOSTS = lib.mkIf (config.extraHosts != [ ]) (lib.concatStringsSep " "
            # A throw, since kubenix has no `assertions` option.
            (map (h: if lib.hasInfix "." h && !lib.hasSuffix ".googleapis.com" h
              then throw "contribs.gcp.extraHosts: ${h} is not a googleapis.com host" else h)
              config.extraHosts));
          GCP_FORGE_POLICY = lib.mkIf (config.forgePolicy != "") config.forgePolicy;
        };
      };
      sandbox.module = ./sandbox.nix;
      skills."scooter-gcp.md" = ./skills/scooter-gcp.md;
    };
  };
}
