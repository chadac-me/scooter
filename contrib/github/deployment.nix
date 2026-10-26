# github's deployment half, gated on contribs.github.enable.
{ config, lib, ... }:

let
  ccfg = config.contribs.github;
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    scooter.broker.extraEnv = [
      { name = "GITHUB_APP_ID"; value = ccfg.appId; }
      { name = "GITHUB_APP_INSTALLATION_ID"; value = ccfg.installationId; }
      {
        name = "GITHUB_APP_PRIVATE_KEY";
        valueFrom.secretKeyRef = {
          name = ccfg.privateKeySecret.name;
          key = ccfg.privateKeySecret.key;
        };
      }
    ] ++ lib.optional (ccfg.forgePolicy != "") { name = "GITHUB_FORGE_POLICY"; value = ccfg.forgePolicy; };
  };
}
