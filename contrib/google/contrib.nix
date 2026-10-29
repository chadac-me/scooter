{ lib, ... }:
let
  clib = import ../lib.nix { inherit lib; };
in
{
  contribs.google = { config, ... }: {
    options.serviceAccountSecret = clib.mkSecretOption {
      key = "GOOGLE_SERVICE_ACCOUNT_JSON";
      holds = "the service-account key JSON";
      description = ''
        Secret holding a Google service-account key (the downloaded JSON file).
        Injected as GOOGLE_SERVICE_ACCOUNT_JSON. The secret must exist in the
        broker namespace.

        Enabling this contrib runs the Google provider: an http-proxy from
        /google/<host>/* to https://<host>.googleapis.com with a short-lived
        access token injected.
      '';
    };

    options.subject = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "agent@example.com";
      description = ''
        The Workspace user to impersonate via domain-wide delegation. Empty acts
        as the service account itself, which only sees what is shared with it.
      '';
    };

    options.impersonateOwner = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Impersonate each conversation's owner (domain-wide delegation) instead of
        `subject`. Owners outside `ownerDomains` get a 403, never a fallback.
      '';
    };

    options.ownerDomains = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "example.com" ];
      description = "Email domains `impersonateOwner` may act for; required when it is on.";
    };

    options.scopes = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "https://www.googleapis.com/auth/drive" ];
      description = ''
        OAuth scopes to request. Empty uses the read-only defaults (Drive, Docs,
        Sheets, Slides, Calendar, Gmail). With delegation, every scope must also be
        granted to the client id in the Workspace admin console.
      '';
    };

    config = {
      src = ./.;
      # pyjwt+cryptography sign the RS256 service-account assertion.
      services.broker = {
        enable = true;
        pythonDeps = ps: [ ps.pyjwt ps.cryptography ];
        env = {
          GOOGLE_SERVICE_ACCOUNT_JSON = config.serviceAccountSecret;
          GOOGLE_SUBJECT = lib.mkIf (config.subject != "") config.subject;
          GOOGLE_SCOPES = lib.mkIf (config.scopes != [ ]) (lib.concatStringsSep " " config.scopes);
          GOOGLE_IMPERSONATE_OWNER = lib.mkIf config.impersonateOwner "true";
          GOOGLE_OWNER_DOMAINS = lib.mkIf config.impersonateOwner
            # A throw, since kubenix has no `assertions` option.
            (if config.ownerDomains == [ ] then throw "contribs.google.impersonateOwner needs contribs.google.ownerDomains"
            else lib.concatStringsSep " " config.ownerDomains);
        };
      };
      skills."scooter-google.md" = ./skills/scooter-google.md;
    };
  };
}
