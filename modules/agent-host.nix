{ config, lib, ... }:

# Shape-only sketch of the agent-host Deployment, which hosts one `goose acp`
# process per conversation and bridges ACP to AG-UI. Its SA needs to create,
# patch and delete Sandboxes, ServiceAccounts and PVCs in cfg.namespace, plus
# `create pods/exec`, because exec is how the ExecBackend runs the agent's
# commands in the sandbox pod.

let
  inherit (lib) mkOption types;
  cfg = config.scooter;
in
{
  config = {
  };
}
