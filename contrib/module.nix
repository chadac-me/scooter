{ config, ... }:

let
  cfg = config.scooter.config;
  inherit (cfg) pkgs;
in
{
  # Built against the contrib-free services, which they in turn extend.
  scooter.config.contribBuild = pkgs.callPackage ./. {
    inherit (cfg) deploymentModules mkScooterTask;
    broker = pkgs.scooter-broker-base;
    webhooks = pkgs.scooter-webhooks-base;
    scooterBrokerLib = pkgs.scooter-broker-lib;
    scooterWebhooksLib = pkgs.scooter-webhooks-lib;
  };
}
