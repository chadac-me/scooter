# lib overlay: cleanSource, minus a package's own module and image files.
# Editing a module then doesn't rebuild the package.
final: _: {
  cleanPackageSource = src: final.cleanSourceWith {
    name = "source";
    src = final.cleanSource src;
    filter = path: _: dirOf path != toString src
      || !(builtins.elem (baseNameOf path) [ "module.nix" "image.nix" "image" ]);
  };
}
