# The nix-stubs overlay for a stub set, shared by the image build (flake.nix) and
# the in-pod re-converge (stub-set.nix) so a self-modify never re-fattens the
# system with the real packages.

{ lockLib # nix-stubs' pure-Nix lib (the flake's `lib`, or the vendored nix/lock.nix)
, flakeLock # the flake.lock that stubs.lock is synced to
, nix-stubs # the prebuilt binary, since a callPackage here would compile Rust in-pod
, stubs ? ./stubs.nix
, lock ? ./stubs.lock
  # Extra arguments for stubs.nix beyond `pkgs` (e.g. `uvNixSrc`). A stubs.nix gets only
  # the ones it declares, so a deployment's own `{ pkgs }:` set still works.
, stubArgs ? { }
}:

lockLib.mkOverlay {
  stubs = p:
    let f = import stubs; in
    f (builtins.intersectAttrs (builtins.functionArgs f) ({ pkgs = p; } // stubArgs));
  inherit lock flakeLock nix-stubs;
}
