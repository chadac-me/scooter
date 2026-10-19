# Which packages are nix-stubs shims, as options so a deployment can point the
# in-pod re-converge at its own stub set. The declarations and lock move together
# (regenerate with `nix run github:chadac/nix-stubs#gen`), since mkOverlay only
# applies declarations with a lock entry.

{ config, lib, stubBits, ... }:

let
  cfg = config.sandboxOs.stubs;
in
{
  options.sandboxOs.stubs = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Replace each package declared in `declarations` with a nix-stubs shim,
        which carries the build recipe instead of the package.
      '';
    };

    declarations = lib.mkOption {
      type = lib.types.path;
      default = ./stubs.nix;
      description = "stubs.nix — the stub set: what to make lazy, and where each package comes from.";
    };

    lock = lib.mkOption {
      type = lib.types.path;
      default = ./stubs.lock;
      description = ''
        stubs.lock — the recorded .drv for each declaration. Must be synced to the
        flake.lock the image was built from; mkOverlay throws if it is not.
      '';
    };
  };

  # `stubBits` is null in every eval except the in-pod re-converge; the image build
  # applies the same overlay at pkgs construction instead.
  config = lib.mkIf (cfg.enable && stubBits != null) {
    nixpkgs.overlays = [
      (import ./stub-overlay.nix {
        inherit (stubBits) lockLib flakeLock nix-stubs stubArgs;
        stubs = cfg.declarations;
        inherit (cfg) lock;
      })
    ];
  };
}
