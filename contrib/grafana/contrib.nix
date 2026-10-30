{ lib, ... }:
let
  inherit (lib) mkOption types;
  clib = import ../lib.nix { inherit lib; };
in
{
  contribs.grafana = { config, ... }: {
    options = {
      url = mkOption {
        type = types.str;
        default = "";
        example = "https://myorg.grafana.net";
        description = "Base URL of the Grafana stack. Upstream for /grafana/*; a trailing slash is stripped.";
      };
      tokenSecret = clib.mkSecretOption {
        key = "GRAFANA_TOKEN";
        holds = "the Grafana service-account token";
        description = ''
          Secret holding a Grafana service-account token. Injected as GRAFANA_TOKEN;
          the secret must exist in the broker namespace. Scope it read-only
          (logs:read / traces:read / metrics:read) when you mint it.

          The broker proxies /grafana/* to `url` with the token attached, so the agent
          can query dashboards and datasources — and through Grafana's datasource
          proxy, the Prometheus and Loki behind them — without ever seeing the token.
          The routes mount iff BOTH `url` and the token are set; otherwise the
          /grafana/* routes never mount and calls 404 rather than failing loudly.
        '';
      };
    };

    config = {
      src = ./.;
      services.broker = {
        enable = true;
        env = {
          GRAFANA_URL = config.url;
          GRAFANA_TOKEN = config.tokenSecret;
        };
      };
      skills."scooter-grafana.md" = ./skills/scooter-grafana.md;
    };
  };
}
