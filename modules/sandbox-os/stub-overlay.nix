# The nix-stubs overlay for a stub set, shared by the image build (flake.nix) and
# the in-pod re-converge (stub-set.nix) so a self-modify never re-fattens the
# system with the real packages.

{ lockLib # nix-stubs' pure-Nix lib (the flake's `lib`, or the vendored nix/lock.nix)
, flakeLock # the flake.lock that stubs.lock is synced to
, nix-stubs # the prebuilt binary, since a callPackage here would compile Rust in-pod
, stubs ? ./stubs.nix
, lock ? ./stubs.lock
}:

lockLib.mkOverlay {
  stubs = p: import stubs { pkgs = p; };
  inherit lock flakeLock nix-stubs;
}
