# gcp's sandbox half: gcloud, a nix-stubs shim (modules/sandbox-os/stubs.nix) that
# materialises on first use, and the placeholder token file it reads. The broker's
# forge proxy replaces the token, so the sandbox holds no credential.
{ pkgs, ... }:
{
  environment.systemPackages = [ pkgs.google-cloud-sdk ];
  environment.etc."scooter/gcp/access-token".text = "scooter-forge-proxy";
}
