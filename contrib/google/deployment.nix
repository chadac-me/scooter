# google's deployment half, gated on contribs.google.enable.
{ config, lib, ... }:

let
  ccfg = config.contribs.google;
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    scooter.broker.extraEnv = [
      {
        name = "GOOGLE_SERVICE_ACCOUNT_JSON";
        valueFrom.secretKeyRef = {
          name = ccfg.serviceAccountSecret.name;
          key = ccfg.serviceAccountSecret.key;
        };
      }
    ]
    ++ lib.optional (ccfg.subject != "") { name = "GOOGLE_SUBJECT"; value = ccfg.subject; }
    ++ lib.optionals ccfg.impersonateOwner [
      { name = "GOOGLE_IMPERSONATE_OWNER"; value = "true"; }
      { name = "GOOGLE_OWNER_DOMAINS"; value =
        # A throw, since kubenix has no `assertions` option.
        if ccfg.ownerDomains == [ ] then throw "contribs.google.impersonateOwner needs contribs.google.ownerDomains"
        else lib.concatStringsSep " " ccfg.ownerDomains; }
    ]
    ++ lib.optional (ccfg.scopes != [ ]) { name = "GOOGLE_SCOPES"; value = lib.concatStringsSep " " ccfg.scopes; };
  };
}
