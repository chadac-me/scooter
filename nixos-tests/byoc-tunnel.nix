# BYOC end-to-end over real networking, in two VMs: the controller's session and
# tunnel plumbing across a process boundary, with two concurrent readers on one
# container session. The controller runs without a DATABASE_URL and keeps the
# owner->session map in memory, which keeps the test hermetic. remoteAgent is not a
# dependency, since its unfree claude CLI would make this check unevaluatable in
# pure mode; a small python websocket client stands in for the container.
{ pkgs, lib, byocController }:

let
  JOIN_SECRET = "nixos-test-join-secret-not-a-real-key";
  PORT = 8080;
in
pkgs.testers.runNixOSTest {
  name = "byoc-tunnel";
  # A hard ceiling on the whole run, backing up the per-wait bounds.
  globalTimeout = 420;

  nodes = {
    # The cloud: just the controller, whose session and tunnel plumbing is
    # self-contained.
    cloud = { ... }: {
      networking.firewall.allowedTCPPorts = [ PORT ];
      # curl + jq for the test's own assertions on this node.
      environment.systemPackages = [ pkgs.curl pkgs.jq pkgs.python3 ];
      systemd.services.byoc-controller = {
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        environment = {
          PORT = toString PORT;
          BYOC_JOIN_SECRET = JOIN_SECRET;
        };
        serviceConfig = {
          ExecStart = "${byocController}/bin/byoc-controller";
          Restart = "no";
        };
      };
    };

    # The user's machine, with no service because the test drives the container by
    # hand to assert on each step.
    laptop = { ... }: {
      environment.systemPackages = [
        pkgs.curl
        pkgs.jq
        # The stand-in container: speaks the attach + tunnel protocol directly.
        (pkgs.python3.withPackages (p: [ p.websockets ]))
      ];
    };
  };

  testScript = ''
    import json

    start_all()
    # Explicit bounds, since an exited service still satisfies wait_for_unit and an
    # unbounded port wait can hang a run with the cause unread in the journal.
    try:
        cloud.wait_for_unit("byoc-controller.service", timeout=90)
        cloud.wait_for_open_port(${toString PORT}, timeout=90)
    except Exception:
        cloud.execute("journalctl -u byoc-controller --no-pager | tail -40 >&2")
        raise
    laptop.wait_for_unit("multi-user.target", timeout=90)

    # --- the controller answers at all ------------------------------------------
    cloud.succeed("curl -sf http://localhost:${toString PORT}/healthz")

    # --- real cross-host connectivity -------------------------------------------
    # Asserted explicitly, since a firewall failure looks exactly like a protocol
    # bug in the logs.
    laptop.succeed("curl -sf http://cloud:${toString PORT}/healthz")

    with subtest("an unknown owner has no session"):
        out = laptop.succeed(
            "curl -sf 'http://cloud:${toString PORT}/byoc/status?owner=nobody'"
        )
        assert json.loads(out).get("status") == "disconnected", out

    with subtest("a session can be minted and starts NOT connected"):
        # POST /byoc/sessions is the authed mint, with identity arriving as the
        # oauth2-proxy header the ingress sets.
        out = cloud.succeed(
            "curl -sf -X POST 'http://localhost:${toString PORT}/byoc/sessions' "
            "-H 'x-auth-request-user: alice' -H 'content-type: application/json'"
        )
        body = json.loads(out)
        assert "sessionId" in body, out
        session = body["sessionId"]
        token = body["token"]

        # "minted" means the row exists but no container has dialled in, and the
        # registry refuses to serve a run in that state.
        st = json.loads(cloud.succeed(
            "curl -sf 'http://localhost:${toString PORT}/byoc/status?owner=alice'"
        ))
        assert st["status"] == "minted", st
        assert st["sessionId"] == session, st

    with subtest("minting REQUIRES an identity"):
        # Without the header the mint is a 401, not an anonymous session: an
        # unauthenticated mint would hand out a tunnel into the cluster.
        laptop.fail(
            "curl -sf -X POST 'http://cloud:${toString PORT}/byoc/sessions' "
            "-H 'content-type: application/json'"
        )

    with subtest("a container ATTACHES over the websocket and reports connected"):
        # /byoc/ws/<session>?token=<joinToken>, with the token on the URL because a
        # browser-less container cannot set an Authorization header on an upgrade.
        laptop.succeed(
            "cat > /tmp/attach.py <<'PY'\n"
            "import asyncio, json, os, sys, websockets\n"
            "async def main():\n"
            "    url = sys.argv[1]\n"
            "    async with websockets.connect(url) as ws:\n"
            "        # The controller confirms the attach with a `connected` frame.\n"
            "        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))\n"
            "        print(json.dumps(msg), flush=True)\n"
            "        # Then act as the container: each line dropped in /tmp/send is a\n"
            "        # tunnel frame id to emit, so the test controls WHEN frames fly and\n"
            "        # the readers are already listening. Held for the rest of the run: a\n"
            "        # short sleep closed the socket mid-poll ('container gone'), which\n"
            "        # reads exactly like a failed attach.\n"
            "        sent = set()\n"
            "        for _ in range(int(float(sys.argv[2]) * 10)):\n"
            "            try:\n"
            "                ids = open('/tmp/send').read().split()\n"
            "            except FileNotFoundError:\n"
            "                ids = []\n"
            "            for i in ids:\n"
            "                if i in sent:\n"
            "                    continue\n"
            "                sent.add(i)\n"
            "                # open then end, exactly as mcpProxy does per request.\n"
            "                await ws.send(json.dumps({'ch': 'tunnel', 'type': 'open', 'id': i,\n"
            "                                          'payload': {'target': 'scooter-env'}}))\n"
            "                await ws.send(json.dumps({'ch': 'tunnel', 'type': 'end', 'id': i,\n"
            "                                          'payload': {}}))\n"
            "            await asyncio.sleep(0.1)\n"
            "asyncio.run(main())\n"
            "PY"
        )
        # Background it: the socket must stay open while we poll status.
        laptop.succeed(
            f"(setsid timeout 300 python3 /tmp/attach.py "
            f"'ws://cloud:${toString PORT}/byoc/ws/{session}?token={token}' 300 "
            f"> /tmp/attach.out 2>/tmp/attach.err &) ; sleep 1"
        )
        cloud.wait_until_succeeds(
            "curl -sf 'http://localhost:${toString PORT}/byoc/status?owner=alice' "
            "| jq -e '.status == \"connected\"'",
            timeout=30,
        )
        # Wait for the container's own confirmation, since the setsid-detached
        # client's stdout lands after the server already considers the session
        # connected.
        laptop.wait_until_succeeds("test -s /tmp/attach.out", timeout=20)
        out = laptop.succeed("cat /tmp/attach.out")
        assert json.loads(out)["type"] == "connected", out

    with subtest("TWO readers on ONE session each receive EVERY tunnel frame"):
        # All of an owner's conversations share one container session and each
        # agent-host bridge opens its own inbound reader on it, a shape a
        # single-process unit test cannot produce.
        cloud.succeed(
            "cat > /tmp/readers.py <<'PY'\n"
            "import json, sys, threading, urllib.request\n"
            "URL = 'http://localhost:${toString PORT}/byoc/' + sys.argv[1] + '/tunnel'\n"
            "WANT = int(sys.argv[2])\n"
            "seen = [[], []]\n"
            "def read(i):\n"
            "    try:\n"
            "        with urllib.request.urlopen(URL, timeout=25) as r:\n"
            "            for raw in r:\n"
            "                line = raw.decode().strip()\n"
            "                if not line.startswith('data:'):\n"
            "                    continue\n"
            "                f = json.loads(line[5:])\n"
            "                if f.get('type') == 'open':\n"
            "                    seen[i].append(f.get('id'))\n"
            "                if len(seen[i]) >= WANT:\n"
            "                    return\n"
            "    except Exception as e:\n"
            "        seen[i].append('ERR:' + type(e).__name__)\n"
            "ts = [threading.Thread(target=read, args=(i,), daemon=True) for i in (0, 1)]\n"
            "for t in ts: t.start()\n"
            "# Readers are attached BEFORE anything is sent; the sender is triggered\n"
            "# by the test once this prints READY.\n"
            "print('READY', flush=True)\n"
            "for t in ts: t.join(25)\n"
            "print(json.dumps(seen), flush=True)\n"
            "PY"
        )
        cloud.succeed(
            f"(setsid timeout 60 python3 /tmp/readers.py {session} 2 > /tmp/readers.out 2>&1 &) ; sleep 1"
        )
        cloud.wait_until_succeeds("grep -q READY /tmp/readers.out", timeout=20)

        # Now the container emits two frames, one per conversation.
        laptop.succeed("printf 'convA-s1\\nconvB-s1\\n' > /tmp/send")

        cloud.wait_until_succeeds("grep -q '\\[\\[' /tmp/readers.out", timeout=30)
        out = cloud.succeed("tail -1 /tmp/readers.out")
        seen = json.loads(out)
        # Both readers must see both frames; each ignores the stream it does not own.
        assert seen[0] == seen[1], f"readers diverged: {seen}"
        assert len(seen[0]) == 2, f"a reader lost a frame: {seen}"
        assert set(seen[0]) == {"convA-s1", "convB-s1"}, f"wrong ids: {seen}"

    with subtest("the inbound tunnel stream is refused for an unknown session"):
        # Names only, resolved server-side: a container must not be able to reach
        # an arbitrary session (or an arbitrary cluster address) through the tunnel.
        laptop.fail(
            "curl -sf --max-time 5 "
            "'http://cloud:${toString PORT}/byoc/not-a-session/tunnel'"
        )
  '';
}
