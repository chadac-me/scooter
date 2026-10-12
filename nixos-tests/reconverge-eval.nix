# Pure eval (no VM): the in-pod re-converge expression evaluates in pure mode
# and instantiates its toplevel. This is the cheap per-PR guard for
# dev-env-scooter-module, the nightly VM test that proves the built system
# switches; it does not replace it.

{ pkgs, lib, sandboxModule ? null }:

let
  reconverged = (import ./reconverged.nix { inherit pkgs lib; }).toplevel;
  # Evaluating `drvPath` instantiates the whole toplevel without building it; discarding the context keeps the check from depending on it.
  drv = builtins.unsafeDiscardStringContext reconverged.drvPath;
in
pkgs.runCommand "dev-env-reconverge-eval" { } ''
  echo "re-converged toplevel instantiates: ${drv}"
  # Named in the log so a hash change is visible in a PR's check output.
  mkdir -p $out
  printf '%s\n' "${drv}" > $out/toplevel.drv
''
