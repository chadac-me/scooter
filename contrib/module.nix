{ config, buildPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  # Built against the contrib-free services, which they in turn extend.
  scooter.config.contribs = buildPkgs.callPackage ./. {
    inherit (cfg) deploymentModules mkScooterTask;
    broker = buildPkgs.scooter-broker-base;
    webhooks = buildPkgs.scooter-webhooks-base;
    scooterBrokerLib = buildPkgs.scooter-broker-lib;
    scooterWebhooksLib = buildPkgs.scooter-webhooks-lib;
  };
}
