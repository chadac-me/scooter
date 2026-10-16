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

  # The prebuilt release, not nixpkgs: the VS Code agent-host bridge needs VS Code >= 1.141.
  code-server = pkgs.callPackage ../../contrib/code-server/code-server-bin { };

  # The Agent Host Protocol server code-server bridges to (contrib/code-server/sandbox.nix).
  scooter-vscode-ahp = pkgs.callPackage ../../contrib/code-server/ahp { };

  awscli2 = { package = pkgs.awscli2; bins = [ "aws" "aws_completer" ]; };
}
