{ config, lib, ... }:

let
  inherit (config.scooter.config) pkgs;
in
{
  # The system-task runtime, and the builder task authors call.
  scooter.packages.scooter-task = lib.mkDefault (pkgs.callPackage ./. { });
  scooter.config.mkScooterTask = pkgs.callPackage ../../../nix/scooter-task.nix { };
}
