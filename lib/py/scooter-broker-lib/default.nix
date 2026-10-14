{ lib, python3Packages, scooterLib, ... }:

# scooter_broker_lib: the broker extension surface (provider/transport/source
# contracts and building blocks) that a provider build-depends on instead of the
# broker app. Depends only on scooter_lib; the DB drivers stay with the app since
# engine creation is lazy.

python3Packages.buildPythonPackage {
  pname = "scooter-broker-lib";
  version = "0.0.0";
  src = ./.;
  pyproject = true;

  build-system = [ python3Packages.hatchling ];

  dependencies = with python3Packages; [
    scooterLib
    fastapi
    httpx
    sqlalchemy
    # A contrib declaring MCP tools imports fastmcp directly.
    fastmcp
  ];

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
    pytest-asyncio
  ];
  # Every sub-package, so a broken import fails this build rather than a provider
  # quietly missing at broker startup.
  pythonImportsCheck = [
    "scooter_broker_lib.types"
    "scooter_broker_lib.registry"
    "scooter_broker_lib.autolink"
    "scooter_broker_lib.sources.static_token"
    "scooter_broker_lib.transports.http_proxy"
    "scooter_broker_lib.transports.git_credential"
    "scooter_broker_lib.transports.whoami"
    "scooter_broker_lib.transports.token_vend"
    "scooter_broker_lib.transports.mcp_tools"
    "scooter_broker_lib.mcp"
    "scooter_broker_lib.links"
    "scooter_broker_lib.refs"
    "scooter_broker_lib.store"
    "scooter_broker_lib.authz"
    "scooter_broker_lib.context"
  ];

  meta.description = "The broker extension surface for Scooter providers";
}
