{ lib, buildNpmPackage, nodejs, makeWrapper, claudeSdkProvider ? null, claude-code ? null, ... }:

# The bring-your-own-Claude container app: drives the user's local Claude via
# @scooter/claude-sdk-provider and tunnels tool-exec back to the cloud sandbox over
# a WebSocket. The bin is wrapped so a glibc `claude` CLI is on PATH.

buildNpmPackage {
  pname = "scooter-remote-agent";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-1IBHrmPuDFmMxBSRkFKl+1Paq0r52Br5Kg+8yTObph4=";
  # The v2 fetcher resolves the SDK's transitive deps from the lockfile.
  npmDepsFetcherVersion = 2;

  nativeBuildInputs = [ makeWrapper ];

  # Peer resolution would reach the registry (ENOTCACHED offline).
  npmFlags = [ "--legacy-peer-deps" ];
  dontNpmPrune = true;

  # Symlink the separately-built provider so it resolves at build and runtime.
  postConfigure = lib.optionalString (claudeSdkProvider != null) ''
    mkdir -p node_modules/@scooter
    ln -s ${claudeSdkProvider}/lib/node_modules/@scooter/claude-sdk-provider \
      node_modules/@scooter/claude-sdk-provider
  '';

  # Install the whole tree and a wrapped bin with a glibc `claude` on PATH, so the
  # SDK spawns it instead of its bundled musl binary.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/scooter-remote-agent
    cp -r dist package.json node_modules $out/lib/scooter-remote-agent/
    makeWrapper ${nodejs}/bin/node $out/bin/scooter-remote-agent \
      --add-flags $out/lib/scooter-remote-agent/dist/main.js \
      ${lib.optionalString (claude-code != null) "--set CLAUDE_CODE_COMMAND ${claude-code}/bin/claude --prefix PATH : ${claude-code}/bin"}
    runHook postInstall
  '';

  meta = {
    description = "Bring-your-own-Claude remote agent (drives local Claude, tunnels tools to the cloud sandbox)";
    mainProgram = "scooter-remote-agent";
  };
}
