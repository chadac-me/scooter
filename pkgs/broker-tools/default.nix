# The credential-broker CLIs the agent's exec'd commands use in the sandbox,
# prebuilt onto the sandbox image since every sandbox needs them.

{ pkgs }:

let
  # A thin curl wrapper for calling the broker with the pod's projected SA token.
  agent-broker = pkgs.writeShellApplication {
    name = "agent-broker";
    runtimeInputs = [ pkgs.curl pkgs.jq pkgs.coreutils ];
    text = builtins.readFile ./agent-broker.sh;
  };

  # A git credential helper; the name is what `git config credential.helper broker`
  # resolves to on PATH.
  git-credential-broker = pkgs.writeShellApplication {
    name = "git-credential-broker";
    runtimeInputs = [ pkgs.curl pkgs.jq pkgs.coreutils ];
    text = builtins.readFile ./git-credential-broker.sh;
  };
in
{
  inherit agent-broker git-credential-broker;

  # Both as a single list, for `environment.systemPackages = scooterBrokerTools.all`.
  all = [ agent-broker git-credential-broker ];
}
