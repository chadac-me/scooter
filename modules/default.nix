{ config, lib, ... }:

# kubenix module entry: the agent-sandbox CR generators (the generic template and
# warm pool, the per-conversation cold Sandbox) and the agent-host Deployment.

let
  inherit (lib) mkOption types;
in
{
  imports = [
    ./sandbox-template.nix
    ./conversation.nix
    # conversation.nix renders the contributed sandbox-pod parts, so their options
    # must be declared in this tree too.
    ./sandbox-pod.nix
    ./agent-host.nix
  ];

  options.scooter = {
    namespace = mkOption {
      type = types.str;
      default = "agent-sandbox";
      description = "Namespace for the platform + sandboxes.";
    };

    sandboxImage = mkOption {
      type = types.str;
      description = "OCI ref of the NixOS systemd-PID-1 dev sandbox image (pkgs/sandbox-os).";
    };

    agentHostImage = mkOption {
      type = types.str;
      description = "OCI ref of the agent-host image.";
    };

    broker.enable = mkOption {
      type = types.bool;
      default = false;
      description = "Deploy the credential broker (post-PoC).";
    };

    webhooks.enable = mkOption {
      type = types.bool;
      default = false;
      description = "Deploy the webhooks spawn-from-conversation service (post-PoC).";
    };
  };
}
