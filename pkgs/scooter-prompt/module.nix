{ config, lib, buildPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  # The built-in prompt task, and the reference mkScooterTask user.
  scooter.packages.scooter-prompt = lib.mkDefault (buildPkgs.callPackage ./. { inherit (cfg) mkScooterTask; });
}
