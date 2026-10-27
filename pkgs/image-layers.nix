{ pkgs, lib, n2c }:

# Layers shared across service images, so the registry dedupes them.
let
  python = n2c.buildLayer { deps = [ pkgs.python3 ]; };
  node = n2c.buildLayer { deps = [ pkgs.nodejs ]; };

  isFirstParty = p: lib.hasPrefix "scooter" (p.pname or "");
in
{
  inherit python node;

  # Third-party python modules, apart from fast-changing first-party code.
  pythonDeps = app: n2c.buildLayer {
    deps = lib.filter (p: !isFirstParty p)
      (pkgs.python3Packages.requiredPythonModules app.propagatedBuildInputs);
    layers = [ python ];
    maxLayers = 60;
  };
}
