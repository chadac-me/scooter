# The full BYOC round trip across three hosts: container -> controller -> agent-host
# -> broker MCP, and the reply all the way back. scooter-broker is offered only when
# both BROKER_MCP_URL and CONV_TOKEN_SECRET are set, so this pins the wiring: with
# both gates set the round trip completes, and with the secret missing the target is
# refused promptly rather than hanging.

{ pkgs, lib, byocController, agentHost }:

let
  JOIN_SECRET = "nixos-test-join-secret-not-a-real-key";
  CONV_SECRET = "nixos-test-conv-token-secret";
  CTRL_PORT = 8080;
  HOST_PORT = 8079;
  BROKER_PORT = 9090;

  fakeBroker = pkgs.writers.writePython3Bin "fake-broker-mcp" { flakeIgnore = [ "E501" ]; }
    (builtins.readFile ./fixtures/fake-broker-mcp.py);

  # The container is a plain file, not a writer: it needs the websockets package,
  # and it runs under the python interpreter installed on `laptop`.
  fakeContainer = ./fixtures/fake-byoc-container.py;
in
pkgs.testers.runNixOSTest {
  name = "byoc-mcp-e2e";
  # A hard ceiling on the whole run, for anything new that blocks forever.
  globalTimeout = 900;

  nodes = {
    # The broker: a fake MCP server that records what arrived, so the test can
    # assert the agent-host attached its own auth rather than forwarding the
    # container's headers.
    broker = { ... }: {
      networking.firewall.allowedTCPPorts = [ BROKER_PORT ];
      systemd.services.fake-broker = {
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        environment.PORT = toString BROKER_PORT;
        serviceConfig = {
          ExecStart = "${fakeBroker}/bin/fake-broker-mcp";
          Restart = "no";
        };
      };
      environment.systemPackages = [ pkgs.curl pkgs.jq ];
    };

    # The cloud: controller + agent-host, as in production.
    cloud = { ... }: {
      networking.firewall.allowedTCPPorts = [ CTRL_PORT HOST_PORT ];
      environment.systemPackages = [ pkgs.curl pkgs.jq pkgs.python3 ];

      systemd.services.byoc-controller = {
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        environment = {
          PORT = toString CTRL_PORT;
          BYOC_JOIN_SECRET = JOIN_SECRET;
        };
        serviceConfig.ExecStart = "${byocController}/bin/byoc-controller";
      };

      systemd.services.agent-host = {
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" "byoc-controller.service" ];
        environment = {
          PORT = toString HOST_PORT;
          AGENT_NAME = "nixos-test";
          # Both gates for scooter-broker, set explicitly here and removed one at a
          # time by a later subtest.
          BROKER_MCP_URL = "http://broker:${toString BROKER_PORT}/mcp";
          CONV_TOKEN_SECRET = CONV_SECRET;
          BYOC_CONTROLLER_URL = "http://127.0.0.1:${toString CTRL_PORT}";
          # Gates the BYOC provider's existence; without it a run silently falls to
          # the cloud agent and no tunnel client starts.
          REMOTE_AGENT_JOIN_SECRET = JOIN_SECRET;
          # No AGENT_HOST_DB_DSN: an absent DSN is in-memory, which keeps this hermetic.
          BROKER_TOKEN_PATH = "/run/broker-token";
          # systemd units get no $HOME, and goose refuses to start without one.
          HOME = "/var/lib/agent-host";
          # One structured line per tunnel event, without which a stalled stream looks
          # identical to a frame that never arrived.
          TUNNEL_TRACE = "1";
          # A fake agent and a fake sandbox, so a BYOC run starts in a bare VM with no
          # model API or k8s to reconcile against.
          GOOSE_BIN = "fake";
          FAKE_SANDBOX = "1";
          GOOSE_MODEL = "model-default";
          AGENT_AVAILABLE_MODELS = "model-default";
          LOCAL_STATE_PATH = "/var/lib/agent-host/state";
          MIRROR_STATE_PATH = "/var/lib/agent-host/mirror";
        };
        serviceConfig = {
          ExecStart = "${agentHost}/bin/agent-host";
          StateDirectory = "agent-host"; # $HOME above
        };
      };

      # The projected SA token kubelet would mount, as a real file so the proxy's
      # re-read-per-request path is the one under test.
      systemd.tmpfiles.rules = [ "f /run/broker-token 0400 root root - test-sa-token" ];
    };

    # The user's machine: the BYOC container.
    laptop = { ... }: {
      environment.systemPackages = [
        pkgs.curl
        pkgs.jq
        (pkgs.python3.withPackages (p: [ p.websockets ]))
      ];
    };
  };

  testScript = ''
    import json

    start_all()
    # Every wait is bounded and every failure prints the journal, since an exited
    # service still satisfies wait_for_unit.
    def boot(node, unit, port=None, unit_timeout=90, port_timeout=90):
        try:
            node.wait_for_unit(unit, timeout=unit_timeout)
            if port is not None:
                node.wait_for_open_port(port, timeout=port_timeout)
        except Exception:
            node.execute(f"journalctl -u {unit} --no-pager | tail -40 >&2")
            raise

    boot(broker, "fake-broker.service", ${toString BROKER_PORT})
    boot(cloud, "byoc-controller.service", ${toString CTRL_PORT})
    boot(cloud, "agent-host.service", ${toString HOST_PORT})
    laptop.wait_for_unit("multi-user.target", timeout=90)

    # Cross-host reachability first, since a firewall problem looks exactly like a
    # protocol bug in the logs.
    cloud.succeed("curl -sf http://broker:${toString BROKER_PORT}/healthz")
    laptop.succeed("curl -sf http://cloud:${toString CTRL_PORT}/healthz")

    laptop.succeed("cp ${fakeContainer} /tmp/container.py")

    OWNER = "alice"

    with subtest("the agent-host OFFERS scooter-broker when both gates are set"):
        # Missing BROKER_MCP_URL or CONV_TOKEN_SECRET drops the target with only an
        # info log.
        cloud.succeed(
            "journalctl -u agent-host --no-pager | "
            "grep -q 'broker MCP tools are NOT offered' && exit 1 || exit 0"
        )

    with subtest("a container attaches and the controller reports CONNECTED"):
        # eligible() requires status == "connected", so the run would decline
        # without this.
        body = json.loads(cloud.succeed(
            "curl -sf -X POST 'http://localhost:${toString CTRL_PORT}/byoc/sessions' "
            f"-H 'x-auth-request-user: {OWNER}' -H 'content-type: application/json'"
        ))
        session, token = body["sessionId"], body["token"]
        laptop.succeed(
            f"(setsid timeout 120 python3 /tmp/container.py "
            f"'ws://cloud:${toString CTRL_PORT}/byoc/ws/{session}?token={token}' "
            f"100 /tmp/report.json > /tmp/container.out 2>/tmp/container.err &) ; sleep 1"
        )
        cloud.wait_until_succeeds(
            "curl -sf 'http://localhost:${toString CTRL_PORT}/byoc/status?owner="
            + OWNER + "' | jq -e '.status == \"connected\"'",
            timeout=40,
        )

    with subtest("a conversation can be created, owned by that user"):
        # The owner stamped here, read from x-auth-user, is the one the bridge later
        # uses (an anonymous caller gets owner=undefined and the BYOC provider
        # declines).
        conv = json.loads(cloud.succeed(
            "curl -sf -X POST 'http://localhost:${toString HOST_PORT}/conversations' "
            f"-H 'x-auth-user: {OWNER}' -H 'content-type: application/json' -d '{{}}'"
        ))
        assert conv.get("id"), conv
        conv_id = conv["id"]

    with subtest("THE RUN: prompting selects BYOC and starts the tunnel client"):
        # POST /agui with no `source` field counts as a human trigger, and since the
        # tunnel client starts before initialize/newSession/prompt a fake agent and a
        # fake container exercise the whole tunnel.
        cloud.succeed(
            "timeout 30 curl -N -s -X POST 'http://localhost:${toString HOST_PORT}/agui' "
            f"-H 'x-auth-user: {OWNER}' -H 'content-type: application/json' "
            f"-d '{{\"threadId\":\"{conv_id}\",\"messages\":[{{\"role\":\"user\",\"content\":\"hi\"}}]}}' "
            "> /tmp/agui.out 2>&1 || true"
        )

        # The tunnel client opens the controller's inbound stream and logs it.
        try:
            cloud.wait_until_succeeds(
                "journalctl -u agent-host --no-pager | grep -q 'following inbound stream'",
                timeout=60,
            )
        except Exception:
            cloud.execute("journalctl -u agent-host --no-pager | tail -60 >&2")
            cloud.execute("cat /tmp/agui.out >&2")
            raise

        # The BYOC provider was selected, not the cloud floor.
        cloud.succeed(
            "journalctl -u agent-host --no-pager | grep -q 'SELECTED'"
        )

    with subtest("the ACP handshake REACHED the container over the relay"):
        # The container writes its report continuously, and initialize is the
        # agent-host's first act on a new client.
        laptop.wait_until_succeeds("test -s /tmp/report.json", timeout=30)
        rep = json.loads(laptop.succeed("cat /tmp/report.json"))
        assert rep["connected"], rep
        # ACP rides its own channel (the agent-host POSTs each frame to
        # /byoc/:session/prompt and the controller relays it over this socket), so
        # `initialize` arriving here proves both hops.
        assert rep.get("initialize_seen"), \
            f"the agent-host never sent ACP initialize — the run did not reach the container: {rep}"

    with subtest("the container is OFFERED scooter-broker, so the agent can see contrib tools"):
        # The offer rides on new_session, and an empty offer is the production
        # symptom of an agent with no tools.
        rep = json.loads(laptop.succeed("cat /tmp/report.json"))
        offer = rep.get("mcp_offer")
        # Narrow diagnostics: a full report dump truncates past the useful part.
        seen = rep.get("acp_seen")
        assert offer is not None, f"new_session never arrived (acp verbs seen: {seen})"
        assert offer, (
            f"NO MCP servers offered — the agent would see no contrib tools. "
            f"acp verbs={seen} offer={offer!r}. Check the three silent gates: "
            f"REMOTE_AGENT_JOIN_SECRET, BROKER_MCP_URL+CONV_TOKEN_SECRET, mcpUrlFor."
        )
        assert "scooter-broker" in offer, f"scooter-broker NOT offered, only {offer}"
        # And it is addressed through the tunnel, not handed a cloud-internal URL
        # the container could never reach.
        full = {o.get("name"): o for o in rep.get("mcp_offer_full", [])}
        broker_offer = full.get("scooter-broker", {})
        assert broker_offer.get("url"), f"the broker offer carries no url: {broker_offer}"
        # Echo it into the test log: a green assertion whose value is invisible is
        # indistinguishable from one reading the wrong field.
        print(f"MCP OFFER = {offer}")
        print(f"scooter-broker url = {broker_offer.get('url')}")

    with subtest("MCP REQUESTS actually complete through the tunnel"):
        # Using the offered target means opening a tunnel stream, sending a JSON-RPC
        # body and reading chunks back until close.
        laptop.wait_until_succeeds(
            "test $(jq '.mcp_calls | length' /tmp/report.json) -ge 2", timeout=60
        )
        rep = json.loads(laptop.succeed("cat /tmp/report.json"))
        calls = rep.get("mcp_calls") or []
        for c in calls:
            print(f"MCP {c.get('target')} {c.get('method')} "
                  f"ok={c.get('ok')} {c.get('elapsed')}s "
                  f"reason={c.get('reason')} closed={c.get('closed')}")

        broker_calls = [c for c in calls if c.get("target") == "scooter-broker"]
        assert broker_calls, f"no MCP call was made to scooter-broker at all: {calls}"
        # A timeout here is the production symptom, so the budget stays well under
        # the 30s CONNECT_TIMEOUT.
        for c in broker_calls:
            assert c.get("reason") != "TIMEOUT", (
                f"MCP {c['method']} to scooter-broker TIMED OUT after {c['elapsed']}s "
                f"— this is the CONNECT_TIMEOUT hang"
            )
            assert c.get("ok"), f"MCP {c['method']} to scooter-broker failed: {c}"
            assert c["elapsed"] < 10, f"MCP {c['method']} took {c['elapsed']}s: {c}"

        # scooter-env too, so a 406 on the other target cannot pass unnoticed.
        env_calls = [c for c in calls if c.get("target") == "scooter-env"]
        assert env_calls, f"no MCP call was made to scooter-env: {calls}"
        for c in env_calls:
            assert c.get("ok"), f"MCP {c['method']} to scooter-env failed: {c}"

        tools = [c for c in broker_calls if c["method"] == "tools/list"]
        assert tools, broker_calls
        names = [t.get("name") for t in tools[0]["reply"]["result"].get("tools", [])]
        print(f"TOOLS FROM BROKER = {names}")
        assert names, f"tools/list returned NO tools — the agent would see none: {tools[0]}"

    with subtest("the broker RECEIVED the calls, with the agent-host's own auth"):
        # Proves the hop reached the broker and that the container's Bearer was
        # replaced rather than forwarded.
        seen = json.loads(broker.succeed(
            "curl -sf http://localhost:${toString BROKER_PORT}/__seen"
        ))
        print(f"BROKER SAW = {[c.get('method') for c in seen]}")
        assert seen, "the broker was NEVER called — nothing reached it"
        assert any(c.get("method") == "tools/list" for c in seen), seen
        auths = [c.get("authorization") for c in seen]
        print(f"BROKER AUTH = {auths}")
        assert not any(a == "Bearer CONTAINER-TOKEN" for a in auths), \
            f"the container's token was FORWARDED to the broker (#700): {auths}"

    with subtest("TWO concurrent conversations on ONE container stay ISOLATED"):
        # Two concurrent conversations sharing one owner's container session must stay
        # isolated at the ACP layer, so a second container holds both prompts before
        # answering either and the relay has two candidate runs when it routes a
        # keyed session_update.
        body2 = json.loads(cloud.succeed(
            "curl -sf -X POST 'http://localhost:${toString CTRL_PORT}/byoc/sessions' "
            f"-H 'x-auth-request-user: {OWNER}' -H 'content-type: application/json'"
        ))
        session2, token2 = body2["sessionId"], body2["token"]
        laptop.succeed(
            f"(setsid timeout 120 env FAKE_CONCURRENCY=2 python3 /tmp/container.py "
            f"'ws://cloud:${toString CTRL_PORT}/byoc/ws/{session2}?token={token2}' "
            f"100 /tmp/report2.json > /tmp/container2.out 2>/tmp/container2.err &) ; sleep 2"
        )
        # Minting a new session rebinds the owner, so status now tracks container 2.
        cloud.wait_until_succeeds(
            "curl -sf 'http://localhost:${toString CTRL_PORT}/byoc/status?owner="
            + OWNER + "' | jq -e '.status == \"connected\"'",
            timeout=40,
        )

        convs = []
        for _ in range(2):
            c = json.loads(cloud.succeed(
                "curl -sf -X POST 'http://localhost:${toString HOST_PORT}/conversations' "
                f"-H 'x-auth-user: {OWNER}' -H 'content-type: application/json' -d '{{}}'"
            ))
            convs.append(c["id"])
        assert convs[0] != convs[1], convs

        # Both prompts fire concurrently, since interleaving is the condition under
        # test.
        for i, cid in enumerate(convs):
            cloud.succeed(
                f"(setsid timeout 40 curl -N -s -X POST "
                f"'http://localhost:${toString HOST_PORT}/agui' "
                f"-H 'x-auth-user: {OWNER}' -H 'content-type: application/json' "
                f"-d '{{\"threadId\":\"{cid}\",\"messages\":"
                f"[{{\"role\":\"user\",\"content\":\"hi {i}\"}}]}}' "
                f"> /tmp/sse-{i}.out 2>&1 &) ; true"
            )

        # Both runs must finish; a stall here means a frame went to the wrong run.
        for i in range(2):
            cloud.wait_until_succeeds(f"test -s /tmp/sse-{i}.out", timeout=60)
        cloud.wait_until_succeeds(
            "test $(journalctl -u agent-host --no-pager | "
            "grep -c 'acp prompt: returned') -ge 2",
            timeout=60,
        )

        # The container minted a distinct acp session per conversation and notified
        # each one separately.
        rep = json.loads(laptop.succeed("cat /tmp/report2.json"))
        notified = rep.get("notified") or []
        print(f"acp sessions notified = {notified}")
        assert len(set(notified)) >= 2, \
            f"the two conversations shared one acp session — no isolation to test: {rep}"

        # Assert at the relay rather than the SSE output: the cloud bridge also drops
        # foreign updates, so a clean stream passes whenever either layer holds,
        # while the controller warns the moment it broadcasts an unkeyed frame
        # across more than one run.
        cloud.succeed(
            "journalctl -u byoc-controller --no-pager | "
            "grep -q 'concurrent runs' && exit 1 || exit 0"
        )

        # And the SSE streams stay clean, which is the user-visible promise the two
        # layers exist to keep.
        bodies = [cloud.succeed(f"cat /tmp/sse-{i}.out") for i in range(2)]
        hits = [[sid for sid in set(notified) if f"from {sid}" in b] for b in bodies]
        print(f"per-stream session texts = {hits}")
        for i, h in enumerate(hits):
            assert len(h) <= 1, \
                f"stream {i} carried {len(h)} sessions' updates — CROSS-TALK: {h}"
        flat = [sid for h in hits for sid in h]
        assert len(flat) == len(set(flat)), f"a session's update reached BOTH streams: {hits}"
  '';
}
