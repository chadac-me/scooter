{ mkScooterTask, runCommand, python3, scooterLib, scooterTask }:

# scooter-prompt: a system task that spawns a prompt as --owner or --per-user. Also the
# reference task built with mkScooterTask.

let
  drv = mkScooterTask {
    name = "scooter-prompt";
    entry = "scooter_prompt:main";
    src = ./.;
  };
  tests = runCommand "scooter-prompt-tests" {
    nativeBuildInputs = [ (python3.withPackages (ps: [ scooterLib scooterTask ps.pytest ])) ];
  } ''
    cp -r ${./.}/. src && chmod -R u+w src && cd src
    PYTHONPATH=$PWD pytest -q tests
    touch $out
  '';
in
drv.overrideAttrs (old: { passthru = (old.passthru or { }) // { inherit tests; }; })
