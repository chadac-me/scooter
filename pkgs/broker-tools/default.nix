# The broker CLI the agent's exec'd commands use in the sandbox,
# prebuilt onto the sandbox image since every sandbox needs them.

{ pkgs }:

let
  # A thin curl wrapper for calling the broker with the pod's projected SA token.
  agent-broker = pkgs.writeShellApplication {
    name = "agent-broker";
    runtimeInputs = [ pkgs.curl pkgs.jq pkgs.coreutils ];
    text = builtins.readFile ./agent-broker.sh;
  };
in
{
  inherit agent-broker;

  # As a list, for `environment.systemPackages = scooterBrokerTools.all`.
  all = [ agent-broker ];
}
