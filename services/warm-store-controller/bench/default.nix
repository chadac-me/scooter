{ python3, writeShellApplication }:

# Usage: nix run .#bench-warm-store -- --src <service dir>
writeShellApplication {
  name = "bench-warm-store";
  runtimeInputs = [ (python3.withPackages (p: [ p.kubernetes ])) ];
  text = ''exec python3 -I ${./.}/run.py "$@"'';
}
