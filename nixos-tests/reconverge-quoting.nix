# Pure build (no VM): the re-converge's module list reaches Nix intact. The list
# is a JSON file read inside scooter-apply-module's `--expr`, so this check asserts
# that the rendered file holds the configured list, that the script reads that file
# with the string context discarded, and that the shell is not assembling the list
# itself. Every assertion runs at build time: reading the rendered list at eval
# would be import-from-derivation, which `nix flake show` evaluates with disabled.

{ pkgs, lib, sandboxModule }:

let
  # nixpkgs' own source stands in for the vendored tree: a bare, already-realised, real store path, which is what storeRef needs and what makes the rendered entry a genuine reference.
  tree = toString pkgs.path;
  treeRelative = "lib/default.nix";

  # Store-path-shaped but nonexistent; nothing here imports them.
  mods = [
    "/nix/store/00000000000000000000000000000000-a-module.nix"
    "/nix/store/11111111111111111111111111111111-b-module.nix"
  ];

  node = (import (pkgs.path + "/nixos/lib/eval-config.nix") {
    inherit (pkgs.stdenv.hostPlatform) system;
    modules = [
      sandboxModule
      {
        programs.scooterModule = {
          enable = true;
          nixpkgs = "/nix/store/22222222222222222222222222222222-source";
          extraReconvergeModules = mods;
          modulesTree = tree;
          extraReconvergeModuleFiles = [ treeRelative ];
        };
        # Trims the kernel and initrd this check has no use for.
        boot.isContainer = true;
      }
    ];
  }).config;

  applyModule =
    lib.findFirst (p: (p.name or "") == "scooter-apply-module")
      (throw "scooter-apply-module is not in environment.systemPackages")
      node.environment.systemPackages;

  # The list as the image renders it, reached through the config so the check fails if the image stops rendering it.
  listFile = node.environment.etc."scooter/reconverge-modules.json".source;

  # The verbatim exprs plus the repo-relative file rebased onto the baked tree.
  expected = mods ++ [ "${tree}/${treeRelative}" ];
  expectedFile = pkgs.writeText "expected-reconverge-modules.json" (builtins.toJSON expected);

  # The rendered list's registered references, observable at build time through closureInfo.
  listClosure = pkgs.closureInfo { rootPaths = [ listFile ]; };
in
pkgs.runCommand "dev-env-reconverge-quoting" { } ''
  script=${applyModule}/bin/scooter-apply-module

  # 1. The rendered list is the configured list, each entry a JSON string.
  echo "rendered list:"
  cat ${listFile}
  ${pkgs.jq}/bin/jq -e 'type == "array"' ${listFile} >/dev/null \
    || { echo "FAIL: ${listFile} is not a JSON array" >&2; exit 1; }
  ${pkgs.jq}/bin/jq -e 'map(type == "string") | all' ${listFile} >/dev/null \
    || { echo "FAIL: an entry is not a JSON string — the carry would hand Nix a path" >&2; exit 1; }
  ${pkgs.jq}/bin/jq -e --slurpfile want ${expectedFile} '. == $want[0]' ${listFile} >/dev/null \
    || { echo "FAIL: rendered list is not the configured list." >&2
         echo "  want: $(cat ${expectedFile})" >&2
         echo "  got:  $(cat ${listFile})" >&2
         exit 1; }

  # 2. The rendered list references the tree, so the in-pod read carries context and the discard below is load-bearing.
  grep -qxF '${tree}' ${listClosure}/store-paths \
    || { echo "FAIL: the rendered list does not reference ${tree}, so this check" >&2
         echo "      cannot see the #718 failure (fromJSON rejecting a store-path" >&2
         echo "      reference). Point the fixture at a real store path again." >&2
         exit 1; }

  # 3. The script reads that file and discards the string context, without which fromJSON refuses the read.
  grep -qF 'builtins.fromJSON (builtins.unsafeDiscardStringContext (builtins.readFile ${listFile}))' "$script" \
    || { echo "FAIL: $script no longer reads ${listFile} inside its --expr," >&2
         echo "      or dropped the unsafeDiscardStringContext around the read (#718)." >&2
         echo "      If the mechanism moved, re-point this check; don't drop it." >&2
         exit 1; }

  # 4. The shell is not assembling the list itself.
  if grep -qE '^ *reconverge_(layers|carry)=' "$script"; then
    echo "FAIL: $script assembles the module list in the shell again — that is #696." >&2
    exit 1
  fi

  mkdir -p $out
  cp ${listFile} $out/reconverge-modules.json
''
