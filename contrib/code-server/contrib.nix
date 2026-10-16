# code-server's declaration: a browser VS Code in the sandbox whose chat continues
# this conversation. Sandbox-only, so its whole surface is ./sandbox.nix; the
# AHP server it bridges to is ./ahp and the code-server release is ./code-server-bin.
# `enable` stays opt-in like every other contrib; this repo's own builds turn it on
# in .github/deployment/config.nix.
{
  contribs.code-server = {
    src = ./.;
    sandbox.module = ./sandbox.nix;
  };
}
