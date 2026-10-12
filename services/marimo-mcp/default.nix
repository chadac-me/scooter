{ lib, buildNpmPackage, nodejs, ... }:

# The isolated marimo MCP server (marimo protocol client + notebook tools), built as
# its own npm package that agent-host symlinks into node_modules/@scooter/marimo-mcp.

buildNpmPackage {
  pname = "marimo-mcp";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-HKok4tz2OSuxl70Lmd5+RiiCLXN9QzE1pqekw9MZXjk=";

  npmFlags = [ "--legacy-peer-deps" ];

  # Keep node_modules so the runtime import resolves.
  dontNpmPrune = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/node_modules/@scooter/marimo-mcp
    cp -r dist package.json node_modules $out/lib/node_modules/@scooter/marimo-mcp/
    runHook postInstall
  '';

  meta.description = "marimo MCP server — notebook tools (isolated)";
}
