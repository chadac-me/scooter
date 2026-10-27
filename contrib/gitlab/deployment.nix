# gitlab's deployment half, gated on contribs.gitlab.enable.
{ config, lib, ... }:

let
  ccfg = config.contribs.gitlab;
  hostEnv = { name = "GITLAB_HOST"; value = ccfg.host; };
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    scooter.broker.extraEnv = [
      hostEnv
      {
        name = "GITLAB_TOKEN";
        valueFrom.secretKeyRef = {
          name = ccfg.tokenSecret.name;
          key = ccfg.tokenSecret.key;
        };
      }
    ] ++ lib.optional (ccfg.forgePolicy != "") { name = "GITLAB_FORGE_POLICY"; value = ccfg.forgePolicy; };

    scooter.webhooks.extraEnv = [ hostEnv ];

    # Placeholder token; the forge proxy swaps in the real one.
    scooter.sandboxPod.extraEnv = [
      hostEnv
      { name = "GITLAB_TOKEN"; value = "scooter-forge-proxy"; }
    ];
  };
}
