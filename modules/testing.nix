# Test-only overrides: everything a cluster/e2e run needs and a production
# deploy must never get. Production modules declare production config
# unconditionally; a test render opts in by importing this module, which
# overrides with `lib.mkForce`, so a deploy that never imports it cannot enable
# a dummy agent or an unauthenticated test webhook.

{ config, lib, ... }:

let
  cfg = config.scooter;
  tcfg = cfg.testing;
in
{
  options.scooter.testing = with lib; {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Turn on TEST-ONLY behaviour. Never set this on a deploy: it swaps the real ACP agent for a
        dummy that returns canned replies, and can expose unauthenticated test endpoints.
      '';
    };

    fakeAgent = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Run the bundled dummy ACP agent (GOOSE_BIN=fake) instead of a real model. The cluster and
        e2e suites need this: they assert on the AG-UI event stream and sandbox behaviour, not on
        model output, and a real model would make them slow, costly, and nondeterministic.
      '';
    };

    testWebhook = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Expose /webhooks/test — an UNAUTHENTICATED conversation-spawning endpoint for the
        spawn-from-webhook e2e. Provider routes verify signatures; this one cannot, which is
        exactly why it is confined to this module.
      '';
    };
  };

  config = lib.mkIf tcfg.enable {
    # Anything a test needs to change about a real deploy belongs here and only here.
    scooter = {
      fakeAgent = lib.mkForce tcfg.fakeAgent;
      webhooks.testWebhook = lib.mkForce tcfg.testWebhook;
      # Near-zero requests for scheduling density, with real limits because a tiny memory limit would OOM-kill the systemd pod at boot.
      sandboxResources = lib.mkForce {
        requests = { cpu = "50m"; memory = "64Mi"; };
        limits = { cpu = "1"; memory = "1Gi"; };
      };
    };

    # A loud, greppable marker that this manifest was rendered with test overrides.
    kubernetes.resources.configMaps.agent-testing-marker = {
      metadata = {
        name = "agent-testing-marker";
        namespace = cfg.namespace;
        labels."app.kubernetes.io/component" = "testing";
      };
      data = {
        warning = "This namespace was rendered with scooter.testing.enable = true. NOT a production deploy.";
        fakeAgent = lib.boolToString tcfg.fakeAgent;
        testWebhook = lib.boolToString tcfg.testWebhook;
      };
    };
  };
}
