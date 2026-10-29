{ lib, ... }:
let
  inherit (lib) mkOption types;
  clib = import ../lib.nix { inherit lib; };
in
{
  contribs.datadog = { config, ... }: {
    options = {
      site = mkOption {
        type = types.str;
        default = "datadoghq.com";
        description = "Datadog site/region host suffix (datadoghq.com | datadoghq.eu | us3.datadoghq.com | us5.datadoghq.com | ap1.datadoghq.com | ddog-gov.com). Upstream is https://api.<site>.";
      };
      apiKeySecret = clib.mkSecretOption {
        key = "DATADOG_API_KEY";
        holds = "the Datadog API key";
        description = "Secret holding the Datadog API key. Injected as DATADOG_API_KEY. The secret must exist in the broker namespace.";
      };
      appKeySecret = clib.mkSecretOption {
        key = "DATADOG_APP_KEY";
        holds = "the Datadog application key";
        description = "Secret holding the Datadog application key. Injected as DATADOG_APP_KEY. The secret must exist in the broker namespace.";
      };
    };

    config = {
      src = ./.;
      services.broker = {
        enable = true;
        env = {
          DATADOG_SITE = config.site;
          DATADOG_API_KEY = config.apiKeySecret;
          DATADOG_APP_KEY = config.appKeySecret;
        };
      };
      skills."scooter-datadog.md" = ./skills/scooter-datadog.md;
    };
  };
}
