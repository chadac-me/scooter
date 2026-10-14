# gitlab's deployment half, gated on contribs.gitlab.enable.
{ config, lib, ... }:

let
  ccfg = config.contribs.gitlab;
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    scooter.broker.extraEnv = [
      {
        name = "GITLAB_TOKEN";
        valueFrom.secretKeyRef = {
          name = ccfg.tokenSecret.name;
          key = ccfg.tokenSecret.key;
        };
      }
    ];
  };
}
