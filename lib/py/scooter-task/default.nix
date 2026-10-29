{ lib, python3Packages, scooter-lib, ... }:

# scooter_task: the runtime every Python system task is written against (the @task
# decorator, its standard CLI flags and TaskContext). nix/scooter-task.nix packages a task.

python3Packages.buildPythonPackage {
  pname = "scooter-task";
  version = "0.0.0";
  src = lib.cleanPackageSource ./.;
  pyproject = true;

  build-system = [ python3Packages.hatchling ];

  dependencies = [ scooter-lib ] ++ (with python3Packages; [ click httpx ]);

  nativeCheckInputs = with python3Packages; [ pytestCheckHook ];
  pythonImportsCheck = [ "scooter_task" ];

  meta.description = "Runtime for Scooter system tasks";
}
