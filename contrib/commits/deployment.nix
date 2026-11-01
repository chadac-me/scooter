# commits' deployment half: where the agent-host relays a proposal's Approve/Deny.
{ config, lib, ... }:

{
  config.scooter.approvals.commits = lib.mkIf (config.scooter.broker.enable && config.contribs.commits.enable) {
    brokerPrefix = "/commits/proposals";
    pendingPath = "/commits/proposals/pending";
  };
}
