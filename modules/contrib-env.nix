# Contrib env: each enabled contrib's `services.<svc>.env` into that service's
# `extraEnv`, so a contrib needs no deployment half just to pass settings through.

{ config, lib, ... }:

let
  enabled = lib.filter (c: c.enable) (lib.attrValues config.contribs);

  toEnv = name: v:
    if builtins.isString v then { inherit name; value = v; }
    else { inherit name; valueFrom.secretKeyRef = { inherit (v) name key; }; };

  envFor = svc: lib.concatMap
    (c: lib.optionals c.services.${svc}.enable (lib.mapAttrsToList toEnv c.services.${svc}.env))
    enabled;
in
{
  # Fixed paths, so learning this module's definitions never forces `config.contribs`.
  config.scooter.broker.extraEnv = lib.mkIf config.scooter.broker.enable (envFor "broker");
  config.scooter.webhooks.extraEnv = lib.mkIf config.scooter.webhooks.enable (envFor "webhooks");
}
