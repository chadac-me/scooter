# Your configuration on top of the local preset (local/preset.nix in Scooter): every
# setting there is a default, so anything set here wins.
{
  scooter = {
    # claude-code (a subscription token), anthropic (an API key), ollama or copilot (a
    # GitHub Copilot seat). `up` asks for the credential once; CLAUDE_CODE_OAUTH_TOKEN /
    # ANTHROPIC_API_KEY / OLLAMA_MODEL / GITHUB_COPILOT_TOKEN in the environment answer
    # it for scripts and the NixOS service.
    local.provider = "claude-code";

    # With ollama, name the model here or let `up` ask:
    # local.provider = "ollama";
    # local.ollama.model = "qwen2.5-coder:7b";

    # Who you are on every request (boards and personal tokens need a user). Left
    # unset, `up` uses SCOOTER_LOCAL_USER / SCOOTER_LOCAL_EMAIL, else your login name
    # and `git config user.email`.
    # local.user = "alice";
    # local.email = "alice@example.com";

    # Bigger sandboxes for bigger builds:
    # sandboxSizes.medium = { cpu = "4"; memory = "8Gi"; hint = "Builds and test suites."; default = true; };
  };

  # Integrations ("Setting up contribs" in the docs); most need a credential Secret.
  # contribs.github.enable = true;
}
