# The sandbox's local HTTPS proxy: forge CONNECTs go to the broker's forge proxy
# with the pod's SA token, everything else is tunnelled directly. Standard library only.
{ lib, buildGoModule }:

buildGoModule {
  pname = "scooter-forge-shim";
  version = "0.0.0";
  src = lib.cleanPackageSource ./.;
  vendorHash = null;
  env.CGO_ENABLED = "0";
  postInstall = ''
    mv $out/bin/forge-shim $out/bin/scooter-forge-shim
  '';
  meta.description = "Scooter sandbox forge proxy shim";
  meta.mainProgram = "scooter-forge-shim";
}
