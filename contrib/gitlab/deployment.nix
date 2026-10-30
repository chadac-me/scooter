# gitlab's deployment half: env that points `glab` in every sandbox pod at the forge proxy.
{ config, lib, ... }:

let
  ccfg = config.contribs.gitlab;
in
{
  # Placeholder token; the forge proxy swaps in the real one.
  config.scooter.sandboxPod.extraEnv = lib.mkIf (config.scooter.broker.enable && ccfg.enable) [
    { name = "GITLAB_HOST"; value = ccfg.host; }
    { name = "GITLAB_TOKEN"; value = "scooter-forge-proxy"; }
  ];
}
