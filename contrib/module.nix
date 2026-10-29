{ config, scooterPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  # Built against the contrib-free services, which they in turn extend.
  scooter.config.contribBuild = scooterPkgs.callPackage ./. {
    inherit (cfg) deploymentModules mkScooterTask;
    broker = scooterPkgs.scooter-broker-base;
    webhooks = scooterPkgs.scooter-webhooks-base;
    scooterBrokerLib = scooterPkgs.scooter-broker-lib;
    scooterWebhooksLib = scooterPkgs.scooter-webhooks-lib;
  };
}
