# The inputs the in-pod re-converge feeds base-config.nix, shared by the runtime
# (runtime-converge.nix) and the nixosTest so both build the same derivations.
# `baseConfig` is the entrypoint the in-pod `nix build` imports, `modulesTree` is
# the repo vendored at its own layout plus the nix-stubs overlay source and binary
# needed to rebuild the stub overlay in-pod, and `modulesSrc` is the modulesPath
# passed to base-config.nix.

{ pkgs, lib
  # `{ src; package; }` of the nix-stubs flake input; null when there is no stub overlay to reconstruct.
, nixStubs ? null
}:

let
  baseConfig = ./base-config.nix;

  # An explicit allowlist of the paths the in-pod re-converge resolves at runtime: everything vendored here lands in every image's content hash, and a missing path fails the re-converge loudly rather than polluting hashes.
  repoRoot = ../../..;
  repoSrc = lib.fileset.toSource {
    root = repoRoot;
    fileset = lib.fileset.unions [
      (repoRoot + "/modules")
      # The re-converge module list names contrib/<name>/sandbox.nix paths under this tree.
      (repoRoot + "/contrib")
      (repoRoot + "/pkgs")
      (repoRoot + "/services")
      (repoRoot + "/lib")
      (repoRoot + "/nix")
      (repoRoot + "/flake.nix")
      (repoRoot + "/flake.lock")
    ];
  };

  modulesTree = pkgs.runCommand "sandbox-os-src" { } (''
    cp -r ${repoSrc} $out
    chmod -R u+w $out
  '' + lib.optionalString (nixStubs != null) ''
    # nix-stubs' Nix side is pure, so it vendors as plain files.
    cp -r ${nixStubs.src}/nix $out/nix-stubs
    # The binary as a bare store path, already in the image closure so the in-pod eval resolves it offline.
    printf '%s' ${lib.escapeShellArg "${nixStubs.package}"} > $out/nix-stubs-bin
  '');
  modulesSrc = "${modulesTree}/modules/sandbox-os";
in
{ inherit baseConfig modulesTree modulesSrc; }
