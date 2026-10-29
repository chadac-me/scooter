{ lib, python3Packages, scooter-schema, scooter-lib, scooter-broker-lib, contribs ? [ ], ... }:

# The credential broker (Python/FastAPI) with extensible provider/transport modules.
# `contribs` are provider packages injected as ordinary dependencies, which the
# provider registry discovers via the `agent_broker.providers` entry point at startup.

python3Packages.buildPythonApplication {
  pname = "agent-broker";
  version = "0.0.0";
  src = (import ../../nix/package-source.nix { inherit lib; }).of ./.;
  pyproject = true;

  build-system = [ python3Packages.setuptools ];

  dependencies = with python3Packages; [
    fastapi
    uvicorn
    httpx
    pydantic
    pydantic-settings
    kubernetes
    pyyaml # sandbox/overlay.py parses the manifest-overlay ConfigMap payload
    sqlalchemy
    asyncpg
    aiosqlite
    openfga-sdk
    pyjwt          # conversation-token verification (core/conv_token.py)
    fastmcp        # serves the agent-facing /mcp endpoint (broker/mcp/routes.py)
    h11            # HTTP/1.1 inside the forge proxy tunnel (broker/forge/proxy.py)
    cryptography   # the forge proxy CA and leaf certificates (broker/forge/ca.py)
    scooter-schema  # generated SQLAlchemy models for the broker DB
    scooter-lib     # shared structured-logging convention
    scooter-broker-lib # the extension surface a provider composes
  ] ++ contribs;

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
    pytest-asyncio
  ];
  pythonImportsCheck = [ "broker.core.app" "broker.forge.proxy" "broker.forge.ca_store" ];

  meta.description = "Extensible credential broker for kubenix-agent-manager";
}
