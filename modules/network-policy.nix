# Sandbox NetworkPolicy: the network wall the in-namespace trust model assumes.
#
# Sandbox pods share the platform namespace, and the agent-host / router main
# listeners trust ingress identity headers, so a sandbox must reach only the
# SA-token-authenticated surfaces (broker, forge proxy, router self-access), DNS,
# and the public internet. Ingress to a sandbox is limited to the platform's own
# pods, which also blocks sandbox-to-sandbox traffic.
#
# On by default; set `scooter.networkPolicy.enable = false` to manage your own.
# Needs a CNI that enforces NetworkPolicy (k3s's built-in controller, Calico,
# Cilium, ...); on one that does not, these objects are inert.

{ config, lib, ... }:

let
  cfg = config.scooter;
  npcfg = cfg.networkPolicy;
  ccfg = cfg.conversationController;

  # The agent-sandbox controller sets this on every sandbox pod and strips any agents.x-k8s.io/*
  # label from the pod template, so the provisioner's own sandbox-name label never reaches the pod.
  sandboxLabel = "agents.x-k8s.io/sandbox-name-hash";
  isSandbox = { matchExpressions = [{ key = sandboxLabel; operator = "Exists"; }]; };
  notSandbox = { matchExpressions = [{ key = sandboxLabel; operator = "DoesNotExist"; }]; };

  tcp = port: { protocol = "TCP"; inherit port; };
  udp = port: { protocol = "UDP"; inherit port; };
  anyPorts = map udp npcfg.udpPorts ++ map tcp npcfg.tcpPorts;

  # Named container ports, so a port change in the owning module cannot drift from here.
  brokerPorts = [ (tcp "http") (tcp "forge-proxy") ];
in
{
  options.scooter.networkPolicy = with lib; {
    enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Render the NetworkPolicies that isolate sandbox pods. Disable only if you
        supply equivalent policies yourself: without them a sandbox can reach the
        agent-host, router and Postgres directly and impersonate any user.
      '';
    };
    internetExcept = mkOption {
      type = types.listOf types.str;
      default = [
        "0.0.0.0/8"
        "10.0.0.0/8"
        "100.64.0.0/10" # CGNAT, which includes Tailscale addresses
        "127.0.0.0/8"
        "169.254.0.0/16" # link-local, which includes cloud metadata endpoints
        "172.16.0.0/12"
        "192.168.0.0/16"
      ];
      description = ''
        IPv4 ranges excluded from the sandbox's "internet" egress rule. They must cover
        the pod, Service and node CIDRs, or a sandbox can reach in-cluster services
        directly. Extend this if your cluster uses public address space internally.
      '';
    };
    udpPorts = mkOption {
      type = types.listOf types.port;
      default = [ 53 ];
      example = [ 53 10053 ];
      description = ''
        UDP ports the sandbox may reach at any destination, including in-cluster
        addresses. The default allows DNS. The policy is evaluated after kube-proxy's
        DNAT, so list the resolver pods' *target* port, not the Service port (NixOS's
        coredns addon listens on 10053).
      '';
    };
    tcpPorts = mkOption {
      type = types.listOf types.port;
      default = [ 53 ];
      example = [ 53 10053 ];
      description = ''
        TCP ports the sandbox may reach at any destination, including in-cluster
        addresses. The default allows DNS over TCP. See `udpPorts` for the DNAT caveat.
      '';
    };
    extraEgress = mkOption {
      type = types.listOf types.attrs;
      default = [ ];
      example = lib.literalExpression ''
        [ { to = [ { ipBlock.cidr = "10.0.5.20/32"; } ]; ports = [ { protocol = "TCP"; port = 443; } ]; } ]
      '';
      description = "Extra NetworkPolicy egress rules for sandbox pods, e.g. an in-network Nix cache.";
    };
  };

  config = lib.mkIf npcfg.enable {
    kubernetes.resources.networkPolicies.sandbox-isolation = {
      metadata = { name = "sandbox-isolation"; namespace = cfg.namespace; };
      spec = {
        podSelector = isSandbox;
        policyTypes = [ "Ingress" "Egress" ];

        # The agent-host and router dial the pod IP directly; nothing else needs to.
        ingress = [{ from = [{ podSelector = notSandbox; }]; }];

        egress =
          # Any destination: NodeLocal DNSCache's host-network IP matches no podSelector.
          # Skipped when empty: a rule with no ports allows everything.
          lib.optional (anyPorts != [ ]) { ports = anyPorts; }
          ++ [{
            to = [{ ipBlock = { cidr = "0.0.0.0/0"; except = npcfg.internetExcept; }; }];
          }]
        ++ lib.optional cfg.broker.enable {
          to = [{ podSelector.matchLabels.app = "agent-broker"; }];
          ports = brokerPorts;
        }
        ++ lib.optional ccfg.selfAccess.enable {
          to = [{ podSelector.matchLabels.app = "conversation-router"; }];
          ports = [ (tcp "self") ];
        }
        ++ npcfg.extraEgress;
      };
    };
  };
}
