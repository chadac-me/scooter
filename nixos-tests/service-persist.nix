# nixosTest: an enabled web service is remembered across a pod recreate.
# `scooter-service start/stop <name>` records the enabled set in
# /workspace/.scooter/services.json on the workspace PVC, and the
# `scooter-service-restore` boot oneshot starts each autostart service from it.
# The recreate is simulated by restarting the oneshot; the real PVC round-trip is
# the Tier-2 suspend-resume test.

{ pkgs, lib, sandboxModule }:

let
  demoServer = pkgs.writeShellScript "demo-web-service" ''
    set -euo pipefail
    exec ${pkgs.python3}/bin/python3 - <<'PY'
    from http.server import BaseHTTPRequestHandler, HTTPServer
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.end_headers(); self.wfile.write(b"demo-ok")
        def log_message(self, *a): pass
    HTTPServer(("0.0.0.0", 9911), H).serve_forever()
    PY
  '';
in
pkgs.testers.runNixOSTest {
  name = "dev-env-service-persist";

  nodes.machine = { lib, ... }: {
    imports = [ sandboxModule ];
    boot.kernelParams = [ "CONVERSATION_ID=conv-test" ];

    webServices.demo = {
      enable = true;
      port = 9911;
      displayName = "Demo";
      command = "${demoServer}";
    };
  };

  testScript = ''
    machine.wait_for_unit("default.target")
    import json

    # The state file lives on the workspace PVC.
    STATE = "/workspace/.scooter/services.json"

    # --- 0. Explicit-start: nothing running, no state yet. ---------------------
    machine.fail("systemctl is-active --quiet webservice-demo.service")

    # --- 1. `scooter-service start` records the enabled set. -------------------
    machine.succeed("scooter-service start demo")
    machine.wait_until_succeeds("systemctl is-active --quiet webservice-demo.service", timeout=30)

    state = json.loads(machine.succeed(f"cat {STATE}"))
    assert "demo" in state.get("enabled", {}), state
    assert state["enabled"]["demo"].get("autostart") is True, state

    # --- 2. Simulate the pod recreate: stop the unit, then run the restore oneshot as boot does.
    machine.succeed("systemctl stop webservice-demo.service")
    machine.fail("systemctl is-active --quiet webservice-demo.service")

    machine.succeed("systemctl restart scooter-service-restore.service")
    machine.wait_until_succeeds("systemctl is-active --quiet webservice-demo.service", timeout=30)
    # The python server binds the socket a beat after the unit is active.
    machine.wait_for_open_port(9911)
    machine.succeed("curl -fsS http://localhost:9911/ | grep -q demo-ok")

    # --- 3. `scooter-service stop` clears autostart. ----------------------------
    machine.succeed("scooter-service stop demo")
    state = json.loads(machine.succeed(f"cat {STATE}"))
    # Removed from `enabled` or present with autostart=false are both valid encodings.
    demo = state.get("enabled", {}).get("demo")
    assert demo is None or demo.get("autostart") is False, state

    # --- 4. A deliberately stopped service is not restored on the next boot. ----
    machine.succeed("systemctl restart scooter-service-restore.service")
    machine.sleep(1)
    machine.fail("systemctl is-active --quiet webservice-demo.service")

    # --- 5. The restore unit is wired into boot and succeeded on this boot. -----
    machine.succeed("systemctl show scooter-service-restore.service -p WantedBy --value "
                    "| grep -q multi-user.target")
    machine.succeed("systemctl show scooter-service-restore.service -p Result --value | grep -q success")
  '';
}
