# jira's deployment half, gated on contribs.jira.enable.
{ config, lib, ... }:

let
  ccfg = config.contribs.jira;
in
{
  config = lib.mkIf ccfg.enable (lib.mkMerge [
    (lib.mkIf config.scooter.broker.enable {
      scooter.broker.extraEnv =
        lib.optional (ccfg.siteUrl != "") { name = "JIRA_SITE_URL"; value = ccfg.siteUrl; };
    })
    (lib.mkIf config.scooter.webhooks.enable {
      scooter.webhooks.extraEnv = [
        { name = "JIRA_ENABLED"; value = lib.boolToString ccfg.webhooksEnabled; }
      ];
    })
  ]);
}
