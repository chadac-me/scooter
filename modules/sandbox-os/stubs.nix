# Tools the sandbox ships as nix-stubs shims: the image carries the build recipe
# and the tool arrives on first use. Lives under modules/sandbox-os/ so the in-pod
# re-converge evaluates the same declarations.

{ pkgs }:

{
  uv = { package = pkgs.uv; bins = [ "uv" ]; };

  # The skills steer the agent to `shell` + `tree`, since goose's built-in reads
  # the agent-host's filesystem.
  tree = pkgs.tree;

  marimo = pkgs.marimo;

  # Multi-output (out + man); the shim must target `out` or it execs a directory.
  ttyd = { package = pkgs.ttyd; output = "out"; };

  code-server = pkgs.code-server;

  awscli2 = { package = pkgs.awscli2; bins = [ "aws" "aws_completer" ]; };
}
