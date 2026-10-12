{ lib, python3Packages, ... }:

# The Conversation CRD controller (Python): a leader-elected reconcile loop that
# assigns each Conversation CR a hostPod and reassigns on pod death.

python3Packages.buildPythonApplication {
  pname = "conversation-controller";
  version = "0.0.0";
  src = ./.;
  pyproject = true;

  build-system = [ python3Packages.setuptools ];

  dependencies = with python3Packages; [
    kubernetes
    psycopg
  ];

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
  ];
  pythonImportsCheck = [ "conversation_controller.app" ];

  meta.description = "Scooter Conversation CRD controller (hostPod assignment)";
}
