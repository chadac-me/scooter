{ lib, buildNpmPackage, nodejs, ... }:

# The isolated Claude Agent SDK provider, built as its own npm package so the SDK's
# zod v4 stays out of the agent-host tree; agent-host symlinks the output into
# node_modules/@scooter/claude-sdk-provider.

buildNpmPackage {
  pname = "claude-sdk-provider";
  version = "0.0.0";
  src = lib.cleanPackageSource ./.;

  npmDepsHash = "sha256-7WJdCLigV9ioEeMnMgbwJzr+uGxYQP3VARbI68RxXp8=";

  # Peer resolution would reach the registry (ENOTCACHED in the sandbox).
  npmFlags = [ "--legacy-peer-deps" ];

  # Keep node_modules in the output so the runtime SDK import resolves.
  dontNpmPrune = true;

  # Install the whole package tree (dist + node_modules) for the symlink.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/node_modules/@scooter/claude-sdk-provider
    cp -r dist package.json node_modules $out/lib/node_modules/@scooter/claude-sdk-provider/
    # Callers always pass pathToClaudeCodeExecutable; drop the SDK's bundled binaries.
    rm -rf $out/lib/node_modules/@scooter/claude-sdk-provider/node_modules/@anthropic-ai/claude-agent-sdk-*
    runHook postInstall
  '';

  meta.description = "Claude Agent SDK-backed AcpClient (isolated; zod v4)";
}
