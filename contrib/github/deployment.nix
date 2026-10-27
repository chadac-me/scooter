# github's deployment half, gated on contribs.github.enable.
{ config, lib, ... }:

let
  ccfg = config.contribs.github;
  hostEnv = { name = "GITHUB_HOST"; value = ccfg.host; };
  dotcom = ccfg.host == "github.com";
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    scooter.broker.extraEnv = [
      hostEnv
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

    scooter.webhooks.extraEnv = [ hostEnv ];

    # Placeholder token; the forge proxy swaps in the real one.
    scooter.sandboxPod.extraEnv =
      if dotcom then [ { name = "GH_TOKEN"; value = "scooter-forge-proxy"; } ]
      else [
        { name = "GH_HOST"; value = ccfg.host; }
        { name = "GH_ENTERPRISE_TOKEN"; value = "scooter-forge-proxy"; }
      ];
  };
}
