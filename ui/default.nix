{ lib, buildNpmPackage, nodejs, ... }:

# UI: assistant-ui frontend + the reusable AG-UI client library (ui/src/client.ts).
# Builds the static site (vite -> dist/) and installs it to $out, ready to be
# copied into an nginx image (pkgs/ui-image). The UI calls the agent-host via
# same-origin relative paths behind a reverse proxy, so VITE_AGENT_HOST_URL is left empty.

let
  fs = lib.fileset;
  # Contrib settings tabs (contrib/<name>/ui/*.tsx) compile into this bundle, so the
  # source is ui/ plus every contrib's ui/ directory, laid out as in the repo. Only
  # those directories: editing a contrib's Python does not rebuild the UI.
  contribUi = lib.filter builtins.pathExists
    (map (n: ../contrib + "/${n}/ui") (builtins.attrNames (builtins.readDir ../contrib)));
in
buildNpmPackage {
  pname = "agent-sandbox-ui";
  version = "0.0.0";
  src = fs.toSource {
    root = ../.;
    fileset = fs.unions ([ ./. ] ++ contribUi);
  };
  sourceRoot = "source/ui";

  npmDepsHash = "sha256-WtziwymLmhRGUlAYDcmmskXpzCM15V0I7BG1UpEXQqk=";

  # Same-origin: relative /agui + /sessions (reverse-proxied to the agent-host).
  VITE_AGENT_HOST_URL = "";


  # A contrib tab lives outside ui/, so its bare imports (react, …) resolve by walking
  # up from contrib/<name>/ui and never meet ui/node_modules. In the repo the npm
  # workspace hoists node_modules to the root; mirror that here.
  postConfigure = ''
    ln -s "$PWD/node_modules" ../node_modules
  '';

  # Static output from `npm run build`, no bin to wrap.
  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r dist/* $out/
    runHook postInstall
  '';

  meta.description = "agent-sandbox UI — assistant-ui + AG-UI runtime (static site)";
}
