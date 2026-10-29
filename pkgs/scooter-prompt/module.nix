{ config, lib, scooterPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  # The built-in prompt task, and the reference mkScooterTask user.
  scooter.packages.scooter-prompt = lib.mkDefault (scooterPkgs.callPackage ./. { inherit (cfg) mkScooterTask; });
}
