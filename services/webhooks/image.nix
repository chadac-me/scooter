{ pkgs, n2c, imageLayers, webhooks }:

# OCI image for the webhooks service.

let
  image = n2c.buildImage {
    name = "agent-webhooks";
    tag = "latest";
    # Shared runtime and third-party layers; first-party paths split from them.
    layers = [ imageLayers.python (imageLayers.pythonDeps webhooks) ];
    maxLayers = 30;
    copyToRoot = pkgs.buildEnv {
      name = "webhooks-root";
      paths = [ webhooks pkgs.cacert ];
      pathsToLink = [ "/bin" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${webhooks}/bin/agent-webhooks" ];
      Env = [
        "PORT=8080"
        "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      ];
      ExposedPorts = { "8080/tcp" = { }; };
    };
  };
in
image
