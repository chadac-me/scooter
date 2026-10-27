# gitlab's sandbox half: `glab`, a nix-stubs shim (modules/sandbox-os/stubs.nix) that
# materialises on first use. It authenticates through the broker's forge proxy
# (GITLAB_TOKEN is a placeholder the proxy replaces), so it holds no credential.
{ pkgs, ... }:
{
  environment.systemPackages = [ pkgs.glab ];
}
