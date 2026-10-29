{ lib, python3Packages, scooter-lib, scooter-schema, ... }:

# scooter_webhooks_lib: the webhooks extension surface (handler contract and the
# spawn/identity/store building blocks) that a handler build-depends on instead of
# the webhooks app. Depends on scooter_lib and scooter_schema.

python3Packages.buildPythonPackage {
  pname = "scooter-webhooks-lib";
  version = "0.0.0";
  src = (import ../../../nix/package-source.nix { inherit lib; }).of ./.;
  pyproject = true;

  build-system = [ python3Packages.hatchling ];

  dependencies = with python3Packages; [
    scooter-lib
    scooter-schema
    fastapi
    httpx
    pydantic
    pydantic-settings
    sqlalchemy
    aiosqlite
    asyncpg
  ];

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
    pytest-asyncio
  ];
  pythonImportsCheck = [
    "scooter_webhooks_lib.registry"
    "scooter_webhooks_lib.store"
    "scooter_webhooks_lib.resources"
    "scooter_webhooks_lib.agent_host_client"
    "scooter_webhooks_lib.identity"
  ];

  meta.description = "The webhooks extension surface for Scooter handlers";
}
