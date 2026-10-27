{ pkgs, lib, n2c, imageLayers, scheduler, mkScooterTask, scooterPrompt, contribTasks ? { }, ... }:

# OCI image for the scheduler service, with every system task it can run.
#
# The image carries the closure of every store path a task run can touch: the contrib
# registry's tasks (contribTasks) and scooter-prompt, unioned with this deployment's
# `scooter.systemTasks`. The deployment's contrib tasks are built by the same function
# from the same source as the registry's, so they add nothing: a deployment whose tasks
# are all contrib tasks gets the image `publish-images.yml` built, byte for byte, and its
# content tag exists on the registry. An operator's own task changes the image, so that
# deployment builds and pushes its own scheduler image. A task whose command is still
# missing at runtime (a ref-only image) is logged and skipped by the scheduler.

let
  buildContribTasks = import ../../contrib/tasks.nix { inherit lib mkScooterTask; };

  # The strings of a task that carry store paths: its command, and any arg with context.
  storeRefs = command: args: [ command ] ++ lib.filter builtins.hasContext args;

  registryRefs = lib.concatLists (lib.mapAttrsToList
    (_: tasks: lib.concatLists (lib.mapAttrsToList (_: t: storeRefs (lib.getExe t.package) t.args) tasks))
    contribTasks)
    ++ [ (lib.getExe scooterPrompt) ];

  mkImage = refs:
    let
      # Deduplicated and sorted, so the same set of paths always writes the same file.
      closure = pkgs.writeText "system-task-closure.json"
        (builtins.toJSON (lib.sort lib.lessThan (lib.unique refs)));
    in
    n2c.buildImage {
      name = "agent-scheduler";
      tag = "latest";
      # Shared runtime and third-party layers; first-party paths split from them.
      layers = [ imageLayers.python (imageLayers.pythonDeps scheduler) ];
      maxLayers = 30;
      copyToRoot = pkgs.buildEnv {
        name = "scheduler-root";
        paths = [ scheduler pkgs.cacert scooterPrompt ];
        pathsToLink = [ "/bin" "/etc/ssl" ];
      };
      config = {
        Entrypoint = [ "${scheduler}/bin/agent-scheduler" ];
        Env = [
          "PORT=8080"
          "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
          # Its string context is what pulls every task's closure into the image.
          "SYSTEM_TASK_CLOSURE=${closure}"
        ];
        ExposedPorts = { "8080/tcp" = { }; };
      };
    };
in
# A kubenix module: this image declares its own scooter.images entry, and maps the
# deployment's enabled contrib tasks into the shared task tree.
{ config, ... }:
let
  enabledContribs = lib.filterAttrs (_: c: c.enable) config.contribs;
  deploymentTasks = buildContribTasks enabledContribs;
  deploymentRefs = lib.concatLists (lib.mapAttrsToList (_: t: storeRefs t.command t.args)
    (lib.filterAttrs (_: t: t.enable) config.scooter.systemTasks));
in
{
  config.scooter.images.agent-scheduler = {
    package = lib.mkDefault (mkImage (registryRefs ++ deploymentRefs));
    attr = "scheduler-image";
    refKey = "scheduler";
  };

  # lib.mkDefault on each field, so an operator tunes one with a plain definition.
  config.scooter.systemTasks = lib.mkMerge (lib.concatLists (lib.mapAttrsToList
    (name: tasks: lib.mapAttrsToList (id: t: {
      "${name}-${id}" = lib.mapAttrs (_: lib.mkDefault) ({
        command = lib.getExe t.package;
        inherit (t) args timezone timeout model;
        contrib = name;
      } // lib.optionalAttrs (t.every != null) { inherit (t) every; }
        // lib.optionalAttrs (t.cron != null) { inherit (t) cron; });
    }) tasks)
    deploymentTasks));
}
