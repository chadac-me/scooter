# brave's deployment half, gated on contribs.brave.enable.
{ config, lib, ... }:

let
  ccfg = config.contribs.brave;
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    scooter.broker.extraEnv = [
      {
        name = "BRAVE_SEARCH_API_KEY";
        valueFrom.secretKeyRef = {
          name = ccfg.apiKeySecret.name;
          key = ccfg.apiKeySecret.key;
        };
      }
    ];
  };
}
