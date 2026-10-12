# nixosTest: the sample systemd service reaches `active`, opens its port, and
# `systemctl stop`/`start` toggles it.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-service";

  nodes.machine = { ... }: {
    imports = [ sandboxModule ];
    services.sampleDevService = { enable = true; port = 8888; };
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    machine.wait_for_unit("sample-dev-service.service")
    machine.wait_for_open_port(8888)
    machine.succeed("curl -fsS http://localhost:8888/ >/dev/null")

    machine.succeed("systemctl stop sample-dev-service.service")
    machine.wait_until_fails("curl -fsS http://localhost:8888/ >/dev/null")

    machine.succeed("systemctl start sample-dev-service.service")
    machine.wait_for_open_port(8888)
    machine.succeed("curl -fsS http://localhost:8888/ >/dev/null")
  '';
}
