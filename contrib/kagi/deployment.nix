# kagi's deployment half, gated on contribs.kagi.enable.
{ config, lib, ... }:

let
  ccfg = config.contribs.kagi;
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    scooter.broker.extraEnv = lib.optional (ccfg.apiKeySecret != null) {
      name = "KAGI_API_KEY";
      valueFrom.secretKeyRef = {
        name = ccfg.apiKeySecret.name;
        key = ccfg.apiKeySecret.key;
      };
    };
  };
}
