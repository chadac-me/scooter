# A package's directory, minus its module.nix and image.nix.
# Editing a module then doesn't rebuild the package.
{ lib }:

rec {
  moduleFiles = root: lib.fileset.unions
    (map (n: lib.fileset.maybeMissing (root + "/${n}")) [ "module.nix" "image.nix" "image" ]);

  of = root: lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.difference root (moduleFiles root);
  };
}
