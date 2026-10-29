{ lib, buildNpmPackage, nodejs, ... }:

# @scooter/svcauth: dependency-free, so consumers only copy in dist/ and package.json.
buildNpmPackage {
  pname = "scooter-svcauth-js";
  version = "0.0.0";
  src = lib.cleanPackageSource ./.;

  npmDepsHash = "sha256-Jm/WKroGgFPzy79pazkp/NP3LqI6blCeD3OqQlXdqLs=";

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/node_modules/@scooter/svcauth
    cp -r dist package.json $out/lib/node_modules/@scooter/svcauth/
    runHook postInstall
  '';

  meta.description = "@scooter/svcauth: ServiceAccount token auth for TS services";
}
