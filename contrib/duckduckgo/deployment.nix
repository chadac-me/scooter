# duckduckgo's deployment half, gated on contribs.duckduckgo.enable.
{ config, lib, ... }:

let
  ccfg = config.contribs.duckduckgo;
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    scooter.broker.extraEnv = [
      { name = "DUCKDUCKGO_ENABLED"; value = "true"; }
    ];
  };
}
