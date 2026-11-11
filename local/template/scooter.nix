# Your settings on top of the preset (modules/local.nix in Scooter): everything there
# is a default, so anything set here wins.
{ lib, ... }:
{
  scooter = {
    # claude-code (a subscription token), anthropic (an API key) or ollama.
    local.provider = "claude-code";
    # For claude-code: the published agent-host-claude tag for the Scooter revision in
    # flake.lock; see "Running on a Claude subscription" in the deploy docs for the
    # one-liner that computes it.
    # local.agentHostClaudeTag = "mk0ycrfj32cl";

    # The port scooter-local maps is the ingress; a deployment of your own may want a
    # hostname instead:
    # ingress.host = "scooter.lan";
  };

  # More integrations: see "Setting up contribs".
  # contribs.github.enable = true;
}
