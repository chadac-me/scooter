{ config, lib, ... }:

# SandboxTemplate for the generic Nix body, plus an optional WarmPool: generic
# capacity with no per-conversation identity or PVCs, unlike the cold Sandboxes
# in ./conversation.nix. The resource shapes are sketched below and not rendered.

let
  inherit (lib) mkOption types;
  cfg = config.scooter;
in
{
  options.scooter.warmPool = {
    enable = mkOption { type = types.bool; default = false; };
    replicas = mkOption { type = types.int; default = 0; };
  };

  config = {
    # Sketch: a SandboxTemplate `agent-sandbox-generic` whose podTemplate runs
    # cfg.sandboxImage with no per-conversation SA, and a SandboxWarmPool over it
    # with cfg.warmPool.replicas when cfg.warmPool.enable.
  };
}
