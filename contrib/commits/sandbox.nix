# commits' sandbox half: switches on the git-identity poller.
{ lib, ... }:

{
  # Beats mkDefault; an explicit setting still wins.
  programs.scooterGitIdentity.enable = lib.mkOverride 900 true;
}
