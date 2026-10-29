{ lib, mkScooterTask, runCommand, python3, scooter-lib, scooter-task }:

# scooter-prompt: a system task that spawns a prompt as --owner or --per-user. Also the
# reference task built with mkScooterTask.

let
  src = (import ../../nix/package-source.nix { inherit lib; }).of ./.;
  drv = mkScooterTask {
    name = "scooter-prompt";
    entry = "scooter_prompt:main";
    inherit src;
  };
  tests = runCommand "scooter-prompt-tests" {
    nativeBuildInputs = [ (python3.withPackages (ps: [ scooter-lib scooter-task ps.pytest ])) ];
  } ''
    cp -r ${src}/. src && chmod -R u+w src && cd src
    PYTHONPATH=$PWD pytest -q tests
    touch $out
  '';
in
drv.overrideAttrs (old: { passthru = (old.passthru or { }) // { inherit tests; }; })
