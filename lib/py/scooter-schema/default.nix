{ lib, python3Packages, ... }:

# scooter_schema: the SQLAlchemy models generated from lib/sql/<db>/schema.sql by
# `just db-generate`, plus the runtime ownership guard.

python3Packages.buildPythonPackage {
  pname = "scooter-schema";
  version = "0.0.0";
  src = lib.cleanPackageSource ./.;
  pyproject = true;

  build-system = [ python3Packages.setuptools ];

  dependencies = with python3Packages; [
    sqlalchemy
  ];

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
  ];
  # Importing each generated module proves the generation produced valid models.
  pythonImportsCheck = [
    "scooter_schema.webhooks"
    "scooter_schema.scheduler"
    "scooter_schema.broker"
    "scooter_schema.byoc"
    "scooter_schema.guard"
  ];

  meta.description = "Generated SQLAlchemy models for Scooter's shared databases";
}
