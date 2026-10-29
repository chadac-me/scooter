{ config, lib, ... }:
{
  # The broker CLI the sandbox's commands call.
  scooter.packages.scooter-broker-tools = lib.mkDefault (config.scooter.config.pkgs.callPackage ./. { }).agent-broker;
}
