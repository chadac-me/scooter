# nixosTest: a deployment-injected CLI tool (programs.injectedTools) resolved from
# a flake mounted at runtime. A tool defined in a deployment's `.scooter/` dir is
# on PATH as a stub and, on first call, builds `path:<dir>#tool` from the mounted
# dir and execs it.

{ pkgs, lib, sandboxModule }:

let
  # The fixture .scooter flake, with its nixpkgs input rewritten to the test's own source so the in-VM build resolves offline.
  scooterDir = pkgs.runCommand "scooter-dir" { } ''
    cp -r ${../nixos-tests/fixtures/injected-tools} $out
    chmod -R +w $out
    substituteInPlace $out/flake.nix \
      --replace 'github:NixOS/nixpkgs' 'path:${pkgs.path}'
  '';

  # The built tool, pre-seeded so the offline in-VM build is a cache hit.
  demoTool = pkgs.writeShellScriptBin "injected-tool" "echo injected-tool-from-mounted-dir-ok";
in
pkgs.testers.runNixOSTest {
  name = "dev-env-injected-tool";

  nodes.machine = { config, pkgs, lib, ... }: {
    imports = [ "${sandboxModule}/injected-tools.nix" "${sandboxModule}/nix-config.nix" ];

    programs.injectedTools = {
      enable = true;
      tools.injected-tool = {
        package = "injected-tool";
        flake = "/etc/agent-sandbox/scooter";
      };
    };
    devEnvNix = { enable = true; nixpkgs = lib.mkForce "path:${pkgs.path}"; };

    # The mounted .scooter dir as a real directory, plus the closures the in-VM build needs offline.
    systemd.tmpfiles.rules = [
      "C+ /etc/agent-sandbox/scooter 0755 root root - ${scooterDir}"
    ];
    system.extraDependencies = [ pkgs.path scooterDir demoTool ];

    nix.settings.experimental-features = [ "nix-command" "flakes" ];
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # The injected tool is on PATH as a stub.
    machine.succeed("command -v injected-tool")

    # The first call builds `path:/etc/agent-sandbox/scooter#injected-tool` from the mounted dir and runs it.
    out = machine.succeed("injected-tool")
    assert "injected-tool-from-mounted-dir-ok" in out, f"injected tool didn't run: {out!r}"

    # Without the .scooter dir the stub errors.
    machine.succeed("rm -rf /etc/agent-sandbox/scooter")
    machine.fail("injected-tool")
  '';
}
