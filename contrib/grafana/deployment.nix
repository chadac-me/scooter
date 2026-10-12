# grafana's deployment half, gated on contribs.grafana.enable.
{ config, lib, ... }:

let
  ccfg = config.contribs.grafana;
in
{
  # Unset env => provider disabled, /grafana/* 404s.
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    scooter.broker.extraEnv = [
      { name = "GRAFANA_URL"; value = ccfg.url; }
      {
        name = "GRAFANA_TOKEN";
        valueFrom.secretKeyRef = {
          name = ccfg.tokenSecret.name;
          key = ccfg.tokenSecret.key;
        };
      }
    ];
  };
}
