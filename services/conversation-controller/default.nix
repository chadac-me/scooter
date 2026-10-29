{ lib, python3Packages, postgresql_16, ... }:

# The conversation controller (Python): a leader-elected reconcile loop that
# assigns each conversations row a host_pod and reassigns on pod death.

python3Packages.buildPythonApplication {
  pname = "conversation-controller";
  version = "0.0.0";
  src = lib.cleanPackageSource ./.;
  pyproject = true;

  build-system = [ python3Packages.setuptools ];

  dependencies = with python3Packages; [
    kubernetes
    psycopg
  ];

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
  ] ++ [ postgresql_16 ];
  # Rows tests use a real Postgres and the real migrations.
  env.AGENT_HOST_MIGRATIONS = "${../../lib/sql/agent_host/migrations}";
  pythonImportsCheck = [ "conversation_controller.app" ];

  meta.description = "Scooter conversation controller (host_pod assignment)";
}
