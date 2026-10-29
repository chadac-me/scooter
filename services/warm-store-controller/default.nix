{ lib, python3Packages, ... }:

# The warm /nix/store PVC pool controller (Python): a leader-elected reconcile loop
# that keeps a pool of overlay-upper PVCs warmed against the current sandbox image
# tag, while the agent-host provisioner does the claim.

python3Packages.buildPythonApplication {
  pname = "warm-store-controller";
  version = "0.0.0";
  src = lib.cleanPackageSource ./.;
  pyproject = true;

  build-system = [ python3Packages.setuptools ];

  dependencies = with python3Packages; [
    kubernetes
  ];

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
  ];
  pythonImportsCheck = [ "warm_store_controller.app" ];

  meta.description = "Scooter warm /nix/store PVC pool controller";
}
