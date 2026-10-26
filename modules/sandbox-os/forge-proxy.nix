# The sandbox half of the broker's forge proxy (scooter.broker.forgeProxy): the
# local shim HTTPS_PROXY points at, and trust in the forge CA.
#
# Both are inert unless the pod mounts the broker's `scooter-forge-ca` ConfigMap
# at /etc/scooter/forge-ca and sets FORGE_PROXY_ADDR, so one image serves
# deployments with the proxy on and off.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.scooterForgeProxy;
  shim = pkgs.callPackage ../../pkgs/forge-shim { };
  caFile = "/etc/scooter/forge-ca/ca.crt";
  # The names NixOS links the system bundle under; every one gets the forge CA.
  bundles = [
    "ssl/certs/ca-certificates.crt"
    "ssl/certs/ca-bundle.crt"
    "pki/tls/certs/ca-bundle.crt"
  ];
in
{
  options.programs.scooterForgeProxy.enable =
    lib.mkEnableOption "the forge proxy shim and forge CA trust" // { default = true; };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ shim ];

    # Activation runs before systemd at boot and again on every switch (which re-links
    # /etc), so the CA is trusted before the agent's first command and survives a
    # scooter-rebuild. Each bundle becomes a real file: the NixOS bundle plus the CA.
    system.activationScripts.scooterForgeCa = {
      deps = [ "etc" ];
      text = ''
        if [ -s ${caFile} ]; then
          ${lib.concatMapStrings (b: ''
            if [ -e /etc/static/${b} ]; then
              tmp=$(mktemp /etc/${b}.XXXXXX)
              cat /etc/static/${b} ${caFile} > "$tmp"
              chmod 0444 "$tmp"
              mv -f "$tmp" /etc/${b}
            fi
          '') bundles}
        fi
      '';
    };

    systemd.services.scooter-forge-shim = {
      description = "Local HTTPS proxy: forge hosts via the broker, everything else direct";
      wantedBy = [ "multi-user.target" ];
      # Loopback only, so it need not wait for the network; starting early narrows the
      # window in which an HTTPS_PROXY client finds nothing listening.
      unitConfig.DefaultDependencies = false;
      after = [ "local-fs.target" ];
      # The pod env reaches PID 1, not services, so it is read from there.
      script = ''
        env_of() { tr '\0' '\n' < /proc/1/environ | sed -n "s/^$1=//p" | head -1; }
        addr=$(env_of FORGE_PROXY_ADDR)
        token=$(env_of BROKER_TOKEN_PATH)
        exec ${lib.getExe shim} -listen 127.0.0.1:3128 -broker "$addr" \
          -token "''${token:-/var/run/secrets/broker/token}" -hosts /etc/scooter/forge-ca/hosts
      '';
      serviceConfig = {
        Restart = "always";
        RestartSec = 1;
      };
    };
  };
}
