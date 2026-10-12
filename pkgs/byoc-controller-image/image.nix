{ pkgs, lib, n2c, byocController, ... }:

# OCI image for the BYOC controller (Node service).

let
  image = n2c.buildImage {
    name = "byoc-controller";
    tag = "latest";
    copyToRoot = pkgs.buildEnv {
      name = "byoc-controller-root";
      # nodejs runs the bin/ entry script, and cacert lets the controller reach
      # Postgres over TLS.
      paths = [ byocController pkgs.nodejs pkgs.cacert ];
      pathsToLink = [ "/bin" "/lib" "/etc/ssl" ];
    };
    config = {
      Entrypoint = [ "${byocController}/bin/byoc-controller" ];
      Env = [ "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt" ];
      ExposedPorts = { "8080/tcp" = { }; };
    };
  };
in
# A kubenix module: this image declares its own scooter.images entry.
{
  config.scooter.images.byoc-controller = {
    package = lib.mkDefault image;
    attr = "byoc-controller-image";
    refKey = "byocController";
  };
}
