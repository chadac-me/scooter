{ lib, writeText, python3Packages, broker, webhooks, scooterBrokerLib, scooterWebhooksLib
, deploymentModules ? [ ]
, ... }:

# Contrib registry: evaluates all-modules.nix, builds it, and buckets it by service.
# The eval is lib-only (contrib/spec.nix) and shared with the sandbox image and the
# kubenix platform; the build (contrib/build.nix) is applied here because this is
# the only consumer with a `pkgs`.

let
  mkUiManifest = import ./ui-manifest.nix { inherit lib writeText; };
  mkPackages = import ./build.nix {
    inherit lib python3Packages broker webhooks scooterBrokerLib scooterWebhooksLib;
  };

  # deploymentModules says which contribs to ship, passed in because this tree is
  # vended.
  evalWith = extraModules: lib.evalModules {
    specialArgs = { inherit lib; };
    modules = [ ./all-modules.nix ] ++ deploymentModules ++ extraModules;
  };

  mkOutputs = eval:
    let
      # Disabled contribs are dropped before anything can reference a package.
      contribs = lib.filterAttrs (_: c: c.enable) eval.config.contribs;

      # name -> service -> derivation.
      byName = mkPackages contribs;

      forService = svc: lib.mapAttrsToList (_: variants: variants.${svc})
        (lib.filterAttrs (_: variants: variants ? ${svc}) byName);

      # Keyed <name>-<service>, since both variants share a derivation name.
      everyVariant = lib.listToAttrs (lib.concatLists (lib.mapAttrsToList
        (name: variants: lib.mapAttrsToList
          (svc: drv: lib.nameValuePair "${name}-${svc}" drv)
          variants)
        byName));
    in
    {
      broker = forService "broker";
      webhooks = forService "webhooks";
      all = everyVariant;

      # The UI half is metadata only and not per-service, so it sits beside the buckets.
      uiManifest = mkUiManifest contribs;
      # Database name -> `<src>/sql`, for the contribs that own a database; the
      # migrator image bundles these beside lib/sql.
      sqlDirs = lib.mapAttrs' (_: c: lib.nameValuePair c.db.name (c.src + "/sql"))
        (lib.filterAttrs (_: c: c.db.enable) contribs);
      packages = byName;
      inherit eval;
    };
in
mkOutputs (evalWith [ ]) // {
  # The same tree with extra modules layered on, which CI uses to build the
  # contribs that ship nowhere.
  withModules = extraModules: mkOutputs (evalWith extraModules);
}
