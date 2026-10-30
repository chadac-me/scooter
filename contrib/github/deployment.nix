# github's deployment half: env that points `gh` in every sandbox pod at the forge proxy.
{ config, lib, ... }:

let
  ccfg = config.contribs.github;
in
{
  # Placeholder token; the forge proxy swaps in the real one.
  config.scooter.sandboxPod.extraEnv = lib.mkIf (config.scooter.broker.enable && ccfg.enable) (
    if ccfg.host == "github.com" then [ { name = "GH_TOKEN"; value = "scooter-forge-proxy"; } ]
    else [
      { name = "GH_HOST"; value = ccfg.host; }
      { name = "GH_ENTERPRISE_TOKEN"; value = "scooter-forge-proxy"; }
    ]);
}
