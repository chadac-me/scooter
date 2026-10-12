# nixosTest: the scooter-rebuild CLI's module-authoring workflow (new, list, show,
# edit, rm on /etc/scooter/modules), its dispatch to the switch/status machinery, and
# the registry subcommands against a fake broker. It does not run a full toplevel
# rebuild; dev-env-scooter-module and the Tier-2 cluster tests cover that.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-scooter-rebuild";

  nodes.machine = { lib, ... }: {
    imports = [ sandboxModule ];
    programs.scooterModule.enable = true;
    # The option is required even though no in-pod build runs here.
    programs.scooterModule.nixpkgs = lib.mkForce "/dev/null";
    programs.scooterModule.applyOnBoot = lib.mkForce false;
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # /etc/scooter/modules is the tmpfiles symlink to the workspace PVC dir.
    machine.succeed("test -L /etc/scooter/modules")
    machine.succeed("test -d /etc/scooter/modules")

    # list on an empty dir prints the hint and exits 0.
    out = machine.succeed("scooter-rebuild module list")
    assert "no modules yet" in out, f"expected empty hint, got: {out!r}"

    # new creates modules/<name>.nix from a template.
    machine.succeed("scooter-rebuild module new mytool")
    machine.succeed("test -f /etc/scooter/modules/mytool.nix")
    # It lands on the real PVC path behind the symlink.
    machine.succeed("test -f /workspace/.scooter/modules/mytool.nix")

    # list shows it by bare name.
    listed = machine.succeed("scooter-rebuild module list").strip()
    assert listed == "mytool", f"expected 'mytool', got: {listed!r}"

    shown = machine.succeed("scooter-rebuild module show mytool")
    assert "NixOS module" in shown, f"template not shown: {shown!r}"

    # new on an existing name must not clobber it.
    machine.fail("scooter-rebuild module new mytool")

    # edit opens $EDITOR on the module file; a script that appends a marker proves it targets the right path.
    machine.succeed(
        "printf '#!/bin/sh\\nprintf \"# edited\\\\n\" >> \"$1\"\\n' > /tmp/ed && chmod +x /tmp/ed"
    )
    machine.succeed("EDITOR=/tmp/ed scooter-rebuild module edit mytool")
    machine.succeed("grep -q '# edited' /etc/scooter/modules/mytool.nix")
    # edit on a non-existent module creates it first.
    machine.succeed("EDITOR=/tmp/ed scooter-rebuild module edit fresh")
    machine.succeed("test -f /etc/scooter/modules/fresh.nix")
    machine.succeed("scooter-rebuild module rm fresh")

    # Path-traversal names are rejected.
    machine.fail("scooter-rebuild module new ../evil")
    machine.fail("scooter-rebuild module show foo/bar")

    machine.succeed("scooter-rebuild module rm mytool")
    machine.fail("test -e /etc/scooter/modules/mytool.nix")
    assert "no modules yet" in machine.succeed("scooter-rebuild module list")

    # --- registry subcommands (against a fake broker HTTP server) ----------------
    # scooter-rebuild bakes the real agent-broker into its PATH, so a fake broker on localhost exercises the real HTTP path and echoes the publish body to /tmp.
    machine.succeed(
        "cat > /root/fakebroker.py <<'PY'\n"
        "import json\n"
        "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
        "from urllib.parse import urlparse, parse_qs\n"
        "class H(BaseHTTPRequestHandler):\n"
        "    def _send(self, code, obj):\n"
        "        b = json.dumps(obj).encode()\n"
        "        self.send_response(code); self.send_header('Content-Type','application/json')\n"
        "        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)\n"
        "    def do_GET(self):\n"
        "        u = urlparse(self.path)\n"
        "        if u.path == '/modules':\n"
        "            self._send(200, {'modules':[{'id':7,'name':'alpha','visibility':'public','description':'a demo'}]})\n"
        "        elif u.path in ('/modules/alpha','/modules/7'):\n"
        "            self._send(200, {'id':7,'name':'alpha','visibility':'public','version':1})\n"
        "        else:\n"
        "            self._send(404, {'detail':'module not found'})\n"
        "    def do_POST(self):\n"
        "        n = int(self.headers.get('Content-Length',0)); body = self.rfile.read(n)\n"
        "        open('/tmp/publish-body.json','wb').write(body)\n"
        "        self._send(201, {'id':42,'name':json.loads(body).get('name'),'visibility':json.loads(body).get('visibility','private'),'version':1})\n"
        "    def log_message(self, *a): pass\n"
        "HTTPServer(('127.0.0.1',8080), H).serve_forever()\n"
        "PY"
    )
    machine.succeed("mkdir -p /var/run/secrets/broker && echo faketoken > /var/run/secrets/broker/token")
    machine.succeed(
        "${pkgs.python3}/bin/python3 /root/fakebroker.py >/tmp/fb.log 2>&1 & echo started"
    )
    machine.wait_until_succeeds("${pkgs.curl}/bin/curl -sf http://127.0.0.1:8080/modules/alpha")

    # BROKER_URL points the real agent-broker at the fake.
    reg = "BROKER_URL=http://127.0.0.1:8080 "

    found = machine.succeed(reg + "scooter-rebuild module search demo")
    assert "alpha" in found and "#7" in found, f"search output: {found!r}"

    assert "no registry modules attached" in machine.succeed("scooter-rebuild module attached")

    # add records the canonical name before the switch, so execute() and assert the file regardless of the apply exit.
    machine.execute(reg + "scooter-rebuild module add alpha")
    machine.succeed("test -f /etc/scooter/registry-modules.json")
    assert machine.succeed("jq -r '.[]' /etc/scooter/registry-modules.json").strip() == "alpha"

    # add by id resolves to the same canonical name and is idempotent.
    machine.execute(reg + "scooter-rebuild module add 7")
    assert machine.succeed("jq -c . /etc/scooter/registry-modules.json").strip() == '[\"alpha\"]'

    assert machine.succeed("scooter-rebuild module attached").strip() == "alpha"

    # add of an unknown ref fails and records nothing.
    machine.fail(reg + "scooter-rebuild module add nope")
    assert machine.succeed("jq -c . /etc/scooter/registry-modules.json").strip() == '[\"alpha\"]'

    # detach removes it, again before the switch.
    machine.execute(reg + "scooter-rebuild module detach alpha")
    assert machine.succeed("jq -c . /etc/scooter/registry-modules.json").strip() == "[]"
    assert "no registry modules attached" in machine.succeed("scooter-rebuild module attached")

    # publish POSTs the local module as files['module.nix'].
    machine.succeed("scooter-rebuild module new mytool")
    pub = machine.succeed(reg + "scooter-rebuild publish mytool")
    assert "#42" in pub, f"publish output: {pub!r}"
    assert machine.succeed("jq -r '.name' /tmp/publish-body.json").strip() == "mytool"
    assert "NixOS module" in machine.succeed("jq -r '.\"files\".\"module.nix\"' /tmp/publish-body.json")
    assert machine.succeed("jq -r '.visibility' /tmp/publish-body.json").strip() == "private"
    machine.succeed(reg + "scooter-rebuild publish mytool --public --description 'hi'")
    assert machine.succeed("jq -r '.visibility' /tmp/publish-body.json").strip() == "public"
    assert machine.succeed("jq -r '.description' /tmp/publish-body.json").strip() == "hi"
    machine.fail(reg + "scooter-rebuild publish ghost")
    machine.succeed("scooter-rebuild module rm mytool")

    # status wraps scooter-env-status and reports ready before any switch.
    st = machine.succeed("scooter-rebuild status")
    assert "ready" in st, f"status not ready: {st!r}"

    # An empty or whitespace-only module is a no-op; nixpkgs=/dev/null here would fail any real build, so this proves the guard skips it.
    machine.succeed(": > /tmp/empty-module.nix")
    out = machine.succeed("scooter-apply-module --module /tmp/empty-module.nix 2>&1")
    assert "nothing to apply" in out, f"empty module not skipped: {out!r}"
    machine.succeed("printf '   \\n\\t\\n' > /tmp/ws-module.nix")
    out = machine.succeed("scooter-apply-module --module /tmp/ws-module.nix 2>&1")
    assert "nothing to apply" in out, f"whitespace module not skipped: {out!r}"
    # Status reflects ready after the no-op.
    assert "ready" in machine.succeed("scooter-rebuild status")

    # Unknown commands exit non-zero with usage.
    machine.fail("scooter-rebuild bogus")
    machine.fail("scooter-rebuild module bogus")
    # --help prints the command list to stderr with the usage exit code.
    help = machine.succeed("scooter-rebuild --help 2>&1 || true")
    assert "scooter-rebuild switch" in help, f"help missing commands: {help!r}"
  '';
}
