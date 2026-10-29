{ pkgs, lib, n2c, imageLayers, scheduler, scooterPrompt
  # Every store path a system task run can touch.
, refs
}:

# The scheduler image, with every runnable task's closure.
# ./module.nix collects `refs`.

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
}
