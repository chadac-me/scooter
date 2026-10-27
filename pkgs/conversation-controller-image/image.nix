{ pkgs, lib, n2c, imageLayers, conversationController, ... }:

# OCI image for the conversation controller.

let
  image = n2c.buildImage {
    name = "conversation-controller";
    tag = "latest";
    # Shared runtime and third-party layers; first-party paths split from them.
    layers = [ imageLayers.python (imageLayers.pythonDeps conversationController) ];
    maxLayers = 30;
    copyToRoot = pkgs.buildEnv {
      name = "conversation-controller-root";
      paths = [ conversationController pkgs.cacert ];
      pathsToLink = [ "/bin" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${conversationController}/bin/conversation-controller" ];
      Env = [ "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt" ];
    };
  };
in
# A kubenix module: this image declares its own scooter.images entry.
{
  config.scooter.images.conversation-controller = {
    package = lib.mkDefault image;
    attr = "conversation-controller-image";
    refKey = "conversationController";
  };
}
