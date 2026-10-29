{ lib, buildGoModule, postgresql_16, ... }:

# The conversation router (Go): fronts the agent-host Service and reverse-proxies
# each request to the agent-host pod that owns the conversation, with one
# httputil.ReverseProxy handling HTTP, SSE and WebSocket uniformly.

buildGoModule {
  pname = "conversation-router";
  version = "0.0.0";
  src = (import ../../nix/package-source.nix { inherit lib; }).of ./.;

  vendorHash = "sha256-wHz3ypgaaUGIZXw9+mCBkYh9Oi+EH1VA0W//p2JicRw=";

  # No cgo needed.
  env.CGO_ENABLED = "0";
  # The claim and trigger tests run against a real Postgres, replaying the migrations of both
  # databases the list stream listens on.
  nativeCheckInputs = [ postgresql_16 ];
  env.AGENT_HOST_MIGRATIONS = "${../../lib/sql/agent_host/migrations}";
  env.WEBHOOKS_MIGRATIONS = "${../../lib/sql/webhooks/migrations}";
  env.AWAITING_INPUT_MIGRATIONS = "${../../contrib/ask-user/sql/migrations}";

  meta.description = "Scooter conversation router (hostPod reverse-proxy)";
}
