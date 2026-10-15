# nixosTest: contrib/files' sandbox half, booted. The viewer's own behaviour is
# covered by its pytest suite; what only a VM can show is the wiring around it —
# that the contrib's module renders a webservice-files unit, that the unit is
# explicit-start like every other web service, and that the base path the viewer
# serves under is the one the proxy forwards, built from the CONVERSATION_ID that
# reaches the pod on PID 1's environ rather than in the unit's own environment.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-contrib-files";

  nodes.machine = {
    imports = [ sandboxModule ../contrib/files/sandbox.nix ];

    # As the container runtime delivers it: on PID 1's environ, not in the systemd
    # manager environment.
    boot.kernelParams = [ "CONVERSATION_ID=conv-files" ];

    # The viewer reads whatever root it is given; /workspace is a PVC mount in
    # production and an ordinary directory here.
    systemd.tmpfiles.rules = [
      "d /workspace 0755 root root -"
      "d /workspace/docs 0755 root root -"
      "f /workspace/docs/design.md 0644 root root - # hello"
      "d /workspace/node_modules 0755 root root -"
    ];
  };

  testScript = ''
    import json

    machine.wait_for_unit("default.target")

    # 1. The contrib's module reaches the discovery manifest the agent-host reads.
    data = json.loads(machine.succeed("cat /run/scooter/web-services.json"))
    svc = {s["name"]: s for s in data["services"]}["files"]
    assert svc["port"] == 7801, svc
    assert svc["unit"] == "webservice-files", svc
    assert svc["basePath"].endswith("/files"), svc
    # The viewer is told its own prefix, so the proxy must NOT strip it: stripping
    # on top of that would 404 every asset.
    assert svc["stripBasePath"] is False, svc

    # 2. Declared costs a manifest entry and no running process.
    machine.fail("systemctl is-active --quiet webservice-files.service")
    machine.succeed("systemctl cat webservice-files.service >/dev/null")

    # 3. Started the way the agent or the Services panel starts it.
    machine.succeed("scooter-service start files")
    machine.wait_for_open_port(7801)

    base = "/c/conv-files/files"

    # 4. It serves under the base path the manifest advertises, and only there —
    # the conversation id came off PID 1's environ, not the unit's environment.
    assert "CONVERSATION_ID" not in machine.succeed("systemctl cat webservice-files.service")
    health = json.loads(machine.succeed(f"curl -fsS http://localhost:7801{base}/api/health"))
    assert health == {"ok": True, "root": "/workspace", "base": base, "vendor": True}, health
    machine.succeed("test $(curl -s -o /dev/null -w '%{http_code}' http://localhost:7801/api/health) = 404")

    # 5. The page is served with its base injected, so its own fetches resolve.
    page = machine.succeed(f"curl -fsS http://localhost:7801{base}/")
    assert "{{BASE}}" not in page, "the base placeholder shipped unsubstituted"
    assert base in page, page[:400]

    # 6. The workspace it lists is the PVC, with the heavy directories flagged
    # rather than walked.
    listing = json.loads(machine.succeed(f"curl -fsS 'http://localhost:7801{base}/api/list?path='"))
    entries = {e["name"]: e for e in listing["entries"]}
    assert entries["docs"]["kind"] == "dir", entries
    assert entries["node_modules"]["skip"] is True, entries

    one = json.loads(machine.succeed(f"curl -fsS 'http://localhost:7801{base}/api/file?path=docs/design.md'"))
    assert one["renderer"] == "markdown", one
    assert "hello" in one["body"], one

    # 6b. The pinned browser assets reach the unit as a store path. This is the
    # seam the pytest suite cannot cover: there, vendor/ is a tmp_path fixture,
    # whereas here it is deps.nix built into the image and handed over in the
    # unit's environment. Without it every document renders as plain text, which
    # is a degradation quiet enough to ship unnoticed.
    for asset in ("markdown-it.min.js", "purify.min.js", "highlight.min.js", "highlight-nix.min.js"):
        size = int(machine.succeed(
            f"curl -fsS -o /dev/null -w '%{{size_download}}' "
            f"'http://localhost:7801{base}/static/vendor/{asset}'"
        ).strip())
        assert size > 1024, f"{asset} served {size} bytes"

    # The Nix grammar is a separate fetch because highlight.js' common bundle
    # omits it, and a sandbox image is mostly .nix files.
    assert "nix" in machine.succeed(
        f"curl -fsS 'http://localhost:7801{base}/static/vendor/highlight-nix.min.js'"
    )

    # 7. Read-only: the viewer offers no write path at all.
    machine.succeed(
        "test $(curl -s -o /dev/null -w '%{http_code}' -X POST "
        f"'http://localhost:7801{base}/api/file?path=docs/design.md') = 501"
    )

    # 8. `scooter-service start` recorded the intent on the PVC, so a pod recreate
    # brings the viewer back without the user asking twice.
    state = json.loads(machine.succeed("cat /workspace/.scooter/services.json"))
    assert state["enabled"]["files"]["autostart"] is True, state
  '';
}
