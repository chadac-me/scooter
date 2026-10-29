{ lib, python3Packages, ... }:

# scooter_lib: the shared, service-agnostic library (logging convention, common
# config/auth primitives, and the Scooter client) the extension-surface libs and the contribs build on.

python3Packages.buildPythonPackage {
  pname = "scooter-lib";
  version = "0.0.0";
  src = lib.cleanPackageSource ./.;
  pyproject = true;

  build-system = [ python3Packages.hatchling ];

  dependencies = with python3Packages; [
    httpx # scooter_lib.client, scooter_lib.svcauth
    pydantic
    pydantic-settings
  ];

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
  ];
  pythonImportsCheck = [ "scooter_lib.logging_config" "scooter_lib.client" "scooter_lib.svcauth" ];

  meta.description = "Shared library for Scooter's Python services";
}
