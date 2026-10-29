{ pkgs, n2c, conversationRouter }:

# OCI image for the conversation router (Go binary).

let
  image = n2c.buildImage {
    name = "conversation-router";
    tag = "latest";
    # Splitting the closure keeps app pushes small.
    maxLayers = 30;
    copyToRoot = pkgs.buildEnv {
      name = "conversation-router-root";
      paths = [ conversationRouter pkgs.cacert ];
      pathsToLink = [ "/bin" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${conversationRouter}/bin/conversation-router" ];
      Env = [ "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt" ];
      ExposedPorts = { "8080/tcp" = { }; };
    };
  };
in
image
