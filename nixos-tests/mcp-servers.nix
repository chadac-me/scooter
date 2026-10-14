# nixosTest: the mcpServers option renders a unit and the discovery manifest,
# auto-assigns ports, and binds loopback by default. Fake python http.servers
# stand in for real MCP servers so the VM stays hermetic; what is under test is
# the module's contract with the agent-host McpServerRegistry.

{ pkgs, lib, sandboxModule }:

let
  # Answers 200 on /mcp echoing CONVERSATION_ID, bound to the address and port it is given.
  fakeServer = pkgs.writeShellScript "fake-mcp-server" ''
    set -euo pipefail
    exec ${pkgs.python3}/bin/python3 - "$1" "$2" <<'PY'
    import os, sys
    from http.server import BaseHTTPRequestHandler, HTTPServer
    addr, port = sys.argv[1], int(sys.argv[2])
    conv = os.environ.get("CONVERSATION_ID", "unset")
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/mcp":
                self.send_response(200); self.end_headers()
                self.wfile.write(b"mcp-ok:" + conv.encode())
            else:
                self.send_response(404); self.end_headers()
        def log_message(self, *a): pass
    HTTPServer((addr, port), H).serve_forever()
    PY
  '';
in
pkgs.testers.runNixOSTest {
  name = "dev-env-mcp-servers";

  nodes.machine = { lib, ... }: {
    imports = [ sandboxModule ];

    # `ss` for the bind-address assertions; it is not in the sandbox image's systemPackages.
    environment.systemPackages = [ pkgs.iproute2 ];

    # Unrecognised kernel cmdline args land on PID 1's environ but not in the systemd manager env, so the module must recover CONVERSATION_ID itself.
    boot.kernelParams = [ "CONVERSATION_ID=conv-test" ];

    # A web service alongside, declared only, for the port-space and restartIfChanged contrasts.
    webServices.terminal.enable = true;

    # Two auto-port servers and one explicit, so assignment by sorted index and coexistence are both covered.
    mcpServers.alpha = {
      enable = true;
      description = "Alpha test server";
      command = "${fakeServer} 127.0.0.1 9700";
      extraConfig.unitConfig.X-Mcp-Test = "yes";
    };
    mcpServers.beta = {
      enable = true;
      command = "${fakeServer} 127.0.0.1 9701";
      autoStart = false;
    };
    mcpServers.gamma = {
      enable = true;
      port = 9911;
      command = "${fakeServer} 127.0.0.1 9911";
      autoStart = false;
    };
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    import json
    data = json.loads(machine.succeed("cat /run/scooter/mcp-servers.json"))
    srv = { s["name"]: s for s in data["servers"] }

    # 1. Ports are auto-assigned by sorted index from the 9700 base, and an explicit port is left alone.
    assert srv["alpha"]["port"] == 9700, srv
    assert srv["beta"]["port"] == 9701, srv
    assert srv["gamma"]["port"] == 9911, srv
    assert srv["alpha"]["unit"] == "mcp-alpha", srv
    assert srv["alpha"]["description"] == "Alpha test server", srv
    assert srv["alpha"]["path"] == "/mcp", srv

    # 2. The manifest carries no credential; access control is the loopback bind.
    assert "token" not in json.dumps(data).lower(), data

    # 3. autoStart defaults on, so alpha is up on its own while beta and gamma are declared but not started.
    machine.wait_for_unit("mcp-alpha.service")
    machine.wait_for_open_port(9700)
    machine.fail("systemctl is-active --quiet mcp-beta.service")
    machine.fail("systemctl is-active --quiet mcp-gamma.service")

    # 4. Loopback by default and the firewall closed: nothing listens off-loopback and there is no accept rule.
    machine.succeed("ss -ltn | grep -q '127.0.0.1:9700'")
    machine.fail("ss -ltn | grep -qE '0\\.0\\.0\\.0:9700|\\*:9700'")
    machine.succeed("systemctl is-active --quiet firewall")
    machine.fail("iptables -S nixos-fw | grep -E -- '--dport 9700 .*-j nixos-fw-accept'")

    # 5. It serves, and CONVERSATION_ID was recovered from /proc/1/environ since the unit does not declare it.
    machine.succeed("curl -fsS http://127.0.0.1:9700/mcp | grep -q 'mcp-ok:conv-test'")
    assert "CONVERSATION_ID" not in machine.succeed("systemctl cat mcp-alpha.service")

    # extraConfig is merged over the generated unit.
    assert "X-Mcp-Test=yes" in machine.succeed("systemctl cat mcp-alpha.service")

    # 6. The unit must restart on change, since a rebuild can renumber an auto-assigned port.
    assert "X-RestartIfChanged=false" not in machine.succeed("systemctl cat mcp-alpha.service")
    assert "X-RestartIfChanged=false" in machine.succeed("systemctl cat webservice-terminal.service")

    # 7. scooter-mcp drives the units without a rebuild and persists intent to the workspace PVC.
    machine.succeed("command -v scooter-mcp")
    machine.succeed("scooter-mcp list | grep -q alpha")
    machine.succeed("scooter-mcp status alpha | grep -q active")
    machine.succeed("scooter-mcp start beta")
    machine.wait_until_succeeds("systemctl is-active --quiet mcp-beta.service", timeout=30)
    machine.succeed("grep -q beta /workspace/.scooter/mcp.json")
    machine.succeed("scooter-mcp stop beta")
    machine.fail("grep -q beta /workspace/.scooter/mcp.json")
    machine.fail("scooter-mcp start nope")

    # 8. restore re-starts what was running before a pod recreate.
    machine.succeed("scooter-mcp start beta")
    machine.succeed("systemctl stop mcp-beta.service")
    machine.succeed("scooter-mcp restore")
    machine.wait_until_succeeds("systemctl is-active --quiet mcp-beta.service", timeout=30)
  '';
}
