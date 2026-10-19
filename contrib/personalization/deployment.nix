# personalization's deployment half, reading contribs.personalization.
{ config, lib, ... }:

let
  bcfg = config.scooter.broker;
  ccfg = config.contribs.personalization;
in
{
  config = lib.mkMerge [
    (lib.mkIf (bcfg.enable && ccfg.enable) {
      scooter.broker.extraEnv = [
        { name = "PERSONALIZATION_ENABLED"; value = "true"; }
      ];
    })
  ];
}
