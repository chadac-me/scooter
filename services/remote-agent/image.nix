{ pkgs, n2c, imageLayers, remoteAgent }:

# OCI image for the bring-your-own-Claude remote agent, which users `docker run`:
# the wrapped remote-agent bin, CA certs, and a minimal shell/coreutils for the
# SDK's `claude` subprocess.

let
  # Big, rarely-changing closures, stacked on the shared node layer.
  claudeLayer = n2c.buildLayer {
    deps = [ pkgs.claude-code ];
    layers = [ imageLayers.node ];
  };
  gitLayer = n2c.buildLayer {
    deps = [ pkgs.git ];
    layers = [ imageLayers.node claudeLayer ];
  };

  image = n2c.buildImage {
    name = "scooter-remote-agent";
    tag = "latest";
    # Splitting the rest keeps app pushes small.
    layers = [ imageLayers.node claudeLayer gitLayer ];
    maxLayers = 30;
    copyToRoot = pkgs.buildEnv {
      name = "remote-agent-root";
      paths = [
        remoteAgent
        pkgs.cacert
        pkgs.bashInteractive
        pkgs.coreutils
        pkgs.git # the agent may clone; harmless if unused
      ];
      pathsToLink = [ "/bin" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${remoteAgent}/bin/scooter-remote-agent" ];
      Env = [
        "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
        # Where Claude Code reads/writes credentials (a mounted volume in the one-liner).
        "CLAUDE_CONFIG_DIR=/root/.claude"
        "HOME=/root"
      ];
      # The local Claude login server, published to the host.
      ExposedPorts = { "34579/tcp" = { }; };
    };
  };
in
image
