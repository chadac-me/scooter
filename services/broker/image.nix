{ pkgs, n2c, imageLayers, broker }:

# OCI image for the credential broker.

let
  image = n2c.buildImage {
    name = "agent-broker";
    tag = "latest";
    # Shared runtime and third-party layers; first-party paths split from them.
    layers = [ imageLayers.python (imageLayers.pythonDeps broker) ];
    maxLayers = 30;
    copyToRoot = pkgs.buildEnv {
      name = "broker-root";
      paths = [ broker pkgs.cacert ];
      pathsToLink = [ "/bin" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${broker}/bin/agent-broker" ];
      Env = [
        "PORT=8080"
        "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      ];
      ExposedPorts = { "8080/tcp" = { }; };
    };
  };
in
image
