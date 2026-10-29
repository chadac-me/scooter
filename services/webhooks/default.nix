{ lib, python3Packages, scooter-schema, scooter-lib, scooter-webhooks-lib, contribs ? [ ], ... }:

# Webhooks service (Python/FastAPI): spawns agent conversations from provider
# threads via the agent-host /agui endpoint. `contribs` are handler packages
# injected as ordinary dependencies, which the handler registry discovers via the
# `scooter_webhooks.handlers` entry point at startup.

python3Packages.buildPythonApplication {
  pname = "agent-webhooks";
  version = "0.0.0";
  src = (import ../../nix/package-source.nix { inherit lib; }).of ./.;
  pyproject = true;

  build-system = [ python3Packages.setuptools ];

  dependencies = with python3Packages; [
    fastapi
    uvicorn
    websockets  # WS server and client (the proxy to the agent-host)
    httpx
    pydantic
    pydantic-settings
    sqlalchemy
    aiosqlite
    asyncpg
    scooter-schema  # generated SQLAlchemy models for the webhooks DB
    scooter-lib     # shared structured-logging convention
    scooter-webhooks-lib # the extension surface a handler composes
  ] ++ contribs;

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
    pytest-asyncio
  ];
  pythonImportsCheck = [ "webhooks.app" ];

  meta.description = "Spawn-from-conversation webhooks for kubenix-agent-manager";
}
