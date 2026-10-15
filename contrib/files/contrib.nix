# files' declaration: a sandbox-side viewer over the workspace, plus the skill that
# teaches the agent to open it for the user. No broker or webhooks half — the
# annotation store it will sync to lands in the broker core beside shares, not in
# a contrib package. `enable` stays opt-in like every other contrib; this repo's
# own builds turn it on in .github/deployment/config.nix.
{
  contribs.files = {
    src = ./.;
    sandbox.module = ./sandbox.nix;
    skills."scooter-files.md" = ./skills/scooter-files.md;
  };
}
