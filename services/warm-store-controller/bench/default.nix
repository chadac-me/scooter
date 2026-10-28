{ python3, writeShellApplication }:

# `bench-warm-store --src <dir> -o out.json`, or `bench-warm-store compare_to ...`.
writeShellApplication {
  name = "bench-warm-store";
  runtimeInputs = [ (python3.withPackages (p: [ p.kubernetes p.pyperf ])) ];
  text = ''
    if [ "''${1:-}" = compare_to ]; then exec python3 -I -m pyperf "$@"; fi
    exec python3 -I ${./.}/run.py "$@"
  '';
}
