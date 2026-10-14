{ lib, buildGoModule, postgresql_16, ... }:

# The conversation router (Go): fronts the agent-host Service and reverse-proxies
# each request to the agent-host pod that owns the conversation, with one
# httputil.ReverseProxy handling HTTP, SSE and WebSocket uniformly.

buildGoModule {
  pname = "conversation-router";
  version = "0.0.0";
  src = ./.;

  vendorHash = "sha256-wHz3ypgaaUGIZXw9+mCBkYh9Oi+EH1VA0W//p2JicRw=";

  # No cgo needed.
  env.CGO_ENABLED = "0";
  # The claim and trigger tests run against a real Postgres.
  nativeCheckInputs = [ postgresql_16 ];
  env.AGENT_HOST_MIGRATIONS = "${../../lib/sql/agent_host/migrations}";

  meta.description = "Scooter conversation router (hostPod reverse-proxy)";
}
