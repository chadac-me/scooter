# The contrib schema, lib-only because it is imported by the package build, the
# sandbox image and the kubenix platform, and only the first has a `pkgs`.
{ lib, ... }:

{
  options.contribs = lib.mkOption {
    default = { };
    description = ''
      Contribs by name — integration packages that plug into a service via entry
      points.

      ONE tree per integration, holding both halves of it: `contrib/<name>/contrib.nix`
      declares what the contrib IS (`src`, `services`, `ui`, `skills`) and whatever
      deployment options it needs, and an operator configures those under
      `contribs.<name>`. `enable` is the single gate — it says whether this build
      contains the integration at all — and `shipGate` in modules/platform.nix fails
      the render for a contrib configured but not shipped.

      The per-contrib options are declared by each contrib using the strict module
      form, which is why `shorthandOnlyDefinesConfig` stays false below.
    '';
    type = lib.types.attrsOf (lib.types.submoduleWith {
      # A contrib may use the strict module form and declare its own options.
      modules = [ ./submodule.nix ];
    });
  };
}
