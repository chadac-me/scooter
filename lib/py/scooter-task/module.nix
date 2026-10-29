{ lib, buildPkgs, ... }:

{
  # The system-task runtime, and the builder task authors call.
  scooter.packages.scooter-task = lib.mkDefault (buildPkgs.callPackage ./. { });
  scooter.config.mkScooterTask = buildPkgs.callPackage ../../../nix/scooter-task.nix { };
}
