{ config, lib, scooterPkgs, ... }:
{
  # The broker CLI the sandbox's commands call.
  scooter.packages.scooter-broker-tools = lib.mkDefault (scooterPkgs.callPackage ./. { }).agent-broker;
}
