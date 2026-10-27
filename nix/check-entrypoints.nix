# Load every entry point of `group` on `package`'s runtime sys.path; fail on any error.
{ pkgs, name, package, bin, group }:

pkgs.runCommand name { } ''
  ${pkgs.python3.interpreter} - <<'PY'
  import re, site
  from importlib.metadata import entry_points
  # The app wrapper's own site dirs: the image's sys.path, no check inputs.
  wrapper = open("${package}/bin/.${bin}-wrapped").read()
  dirs = re.findall(r"'(/nix/store/[^']+/site-packages)'", wrapper)
  assert dirs, "no site dirs found in the ${bin} wrapper"
  for d in dirs:
      site.addsitedir(d)
  eps = list(entry_points(group="${group}"))
  # An empty group means the wiring broke, not that everything loaded.
  assert eps, "no ${group} entry points on the ${bin} runtime path"
  failures = {}
  for ep in eps:
      try:
          ep.load()
      except Exception as e:
          failures[ep.name] = f"{type(e).__name__}: {e}"
  print("loaded:", sorted(ep.name for ep in eps if ep.name not in failures))
  assert not failures, failures
  PY
  touch $out
''
