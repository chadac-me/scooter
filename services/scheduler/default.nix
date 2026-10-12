{ lib, python3Packages, ... }:

# Scheduler service (Python/FastAPI): fires cron-scheduled tasks by spawning a
# fresh conversation per run, with a REST API to manage tasks.

python3Packages.buildPythonApplication {
  pname = "agent-scheduler";
  version = "0.0.0";
  src = ./.;
  pyproject = true;

  build-system = [ python3Packages.setuptools ];

  dependencies = with python3Packages; [
    fastapi
    uvicorn
    httpx
    pydantic
    pydantic-settings
    sqlalchemy
    aiosqlite
    asyncpg
    croniter
    opentelemetry-api
    opentelemetry-sdk
    opentelemetry-exporter-otlp-proto-http
  ];

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
    pytest-asyncio
  ];
  pythonImportsCheck = [ "scheduler.app" ];

  meta.description = "Scheduled Scooter tasks — cron-spawn conversations";
}
