# BYOC end-to-end over REAL networking, in two VMs.
#
# WHY THIS EXISTS. The BYO-container path broke in production three separate ways
# and none was catchable by the tiers we had:
#
#   1. MCP tunnel frames reached the WRONG conversation. All of an owner's
#      conversations share ONE container session, each agent-host bridge starts its
#      OWN reader on it, and the controller woke a single reader draining a shared
#      queue with q.shift() -- so a frame for conversation A was consumed by B's
#      reader, matched no stream there, and vanished. The sender then waited out a
#      full 30s CONNECT_TIMEOUT. Unit tests could not see it (one process, no
#      sockets); e2e could not either (the fake stack has no container).
#   2. The container had no /tmp, so a skills mkdtemp threw and killed every
#      session at creation.
#   3. The agent-host offered scooter-broker but never threaded its URL to the
#      inbound stream, so a target it advertised was refused on arrival.
#
# All three are NETWORK/PROCESS-BOUNDARY failures: two processes, a websocket, and
# an HTTP tunnel between them. A VM pair is the cheapest honest reproduction.
#
# The controller runs WITHOUT a DATABASE_URL on purpose -- it warns and keeps the
# owner->session map in memory (index.ts:51), which is all a single-run test needs
# and keeps this hermetic (no Postgres to provision).

# remoteAgent is deliberately NOT a dependency: it bakes the unfree claude CLI, so
# naming it here makes this check unevaluatable in pure mode (the same constraint
# that keeps it out of the shared images tree). The container side of the wire is
# exercised with a small python websocket client instead, which is enough to assert
# the ATTACH + TUNNEL protocol -- what actually broke -- without an unfree closure.
{ pkgs, lib, byocController }:

let
  JOIN_SECRET = "nixos-test-join-secret-not-a-real-key";
  PORT = 8080;
in
pkgs.testers.runNixOSTest {
  name = "byoc-tunnel";
  # A HARD ceiling on the whole run, backing up the per-wait bounds.
  globalTimeout = 420;

  nodes = {
    # The cloud: just the controller. A real agent-host needs Postgres + a sandbox,
    # which is the Tier-2 cluster test's job; what is under test here is the
    # controller's SESSION + TUNNEL plumbing, which is self-contained.
    cloud = { ... }: {
      networking.firewall.allowedTCPPorts = [ PORT ];
      # curl + jq for the test's own assertions ON this node: the status poll and
      # the two-reader check both run here, and a missing jq makes a passing
      # predicate look like a product failure.
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

    # The user's machine. No service: the test drives the container by hand so it
    # can assert on each step rather than on a healthy end state.
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
    # EXPLICIT bounds: an exited service still satisfies wait_for_unit, so an
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

    # --- REAL cross-host connectivity -------------------------------------------
    # Asserted explicitly: a tunnel failure that is actually a firewall looks
    # exactly like a protocol bug from the logs, and that cost real debugging time.
    laptop.succeed("curl -sf http://cloud:${toString PORT}/healthz")

    with subtest("an unknown owner has no session"):
        out = laptop.succeed(
            "curl -sf 'http://cloud:${toString PORT}/byoc/status?owner=nobody'"
        )
        assert json.loads(out).get("status") == "disconnected", out

    with subtest("a session can be minted and starts NOT connected"):
        # POST /byoc/sessions is the AUTHED mint. Identity arrives as the
        # oauth2-proxy header the ingress sets (index.ts:79) -- in production a
        # browser cannot forge it because the ingress strips and re-adds it.
        out = cloud.succeed(
            "curl -sf -X POST 'http://localhost:${toString PORT}/byoc/sessions' "
            "-H 'x-auth-request-user: alice' -H 'content-type: application/json'"
        )
        body = json.loads(out)
        assert "sessionId" in body, out
        session = body["sessionId"]
        token = body["token"]

        # "minted" means the row exists but no container has dialled in. The
        # registry refuses to serve a run in that state on purpose: routing a
        # prompt at a socket nobody holds would hang.
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
        # /byoc/ws/<session>?token=<joinToken> (index.ts:141). The token rides on
        # the URL because a browser-less container cannot set an Authorization
        # header on an upgrade.
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
        # Background it: the socket must stay OPEN while we poll status.
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
        # The container saw its confirmation, not just the server's view. Wait for
        # the write: the client is setsid-detached, so its stdout lands a moment
        # after the server already considers the session connected.
        laptop.wait_until_succeeds("test -s /tmp/attach.out", timeout=20)
        out = laptop.succeed("cat /tmp/attach.out")
        assert json.loads(out)["type"] == "connected", out

    with subtest("TWO readers on ONE session each receive EVERY tunnel frame"):
        # THE REGRESSION. All of an owner's conversations share one container
        # session, and each agent-host bridge opens its OWN inbound reader on it.
        # The controller used to wake ONE reader and let readers drain a SHARED
        # queue with q.shift(), so a frame for conversation A could be consumed by
        # B's reader, match no stream there, and vanish -- the sender then burned a
        # full 30s CONNECT_TIMEOUT. Two concurrent readers on one session is
        # exactly the shape a single-process unit test cannot produce.
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
        # BOTH readers must see BOTH frames; each ignores the stream it does not own.
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
