# A package's directory as its build source, minus the module-system files kept
# beside it, so editing a module or image does not rebuild the package.
{ lib }:

rec {
  moduleFiles = root: lib.fileset.unions
    (map (n: lib.fileset.maybeMissing (root + "/${n}")) [ "module.nix" "image.nix" "image" ]);

  of = root: lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.difference root (moduleFiles root);
  };
}
