{ lib, buildNpmPackage, nodejs, ... }:

# UI: assistant-ui frontend + the reusable AG-UI client library (ui/src/client.ts).
# Builds the static site (vite -> dist/) and installs it to $out, ready to be
# copied into an nginx image (pkgs/ui-image). The UI calls the agent-host via
# same-origin relative paths behind a reverse proxy, so VITE_AGENT_HOST_URL is left empty.

buildNpmPackage {
  pname = "agent-sandbox-ui";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-1cOej29YtcUgfUbhVrDy+IiZ8tq5hcFiCLMIMKXc6+U=";

  # Same-origin: relative /agui + /sessions (reverse-proxied to the agent-host).
  VITE_AGENT_HOST_URL = "";


  # Static output from `npm run build`, no bin to wrap.
  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r dist/* $out/
    runHook postInstall
  '';

  meta.description = "agent-sandbox UI — assistant-ui + AG-UI runtime (static site)";
}
