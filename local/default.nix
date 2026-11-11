# `scooter-local`: local/scooter-local.sh with its tools and the three provider
# renders baked in. flake.nix exposes it as packages.scooter-local and apps.local.
{ pkgs, lib, version, flake, manifests, agentSandboxVersion }:
let
  # Only the build-time placeholders; the script keeps the renders' runtime ones
  # (@AGENT_HOST_CLAUDE_TAG@, @OLLAMA_HOST@, @OLLAMA_MODEL@) for `up` to fill in.
  vars = {
    "@version@" = version;
    "@flake@" = toString flake;
    "@agentSandboxVersion@" = agentSandboxVersion;
    "@manifestsClaudeCode@" = toString manifests.claude-code;
    "@manifestsAnthropic@" = toString manifests.anthropic;
    "@manifestsOllama@" = toString manifests.ollama;
  };
  text = builtins.replaceStrings (builtins.attrNames vars) (builtins.attrValues vars)
    (builtins.readFile ./scooter-local.sh);
in
pkgs.writeShellApplication {
  name = "scooter-local";
  runtimeInputs = with pkgs; [ k3d kubectl jq curl openssl coreutils gnused gnugrep ];
  inherit text;
  meta = {
    description = "Run Scooter on this machine, in a k3d cluster, from the published images";
    mainProgram = "scooter-local";
    platforms = lib.platforms.unix;
  };
}
