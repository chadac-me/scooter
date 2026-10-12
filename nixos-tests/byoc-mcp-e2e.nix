# The FULL BYOC round trip across three hosts: container -> controller -> agent-host
# -> broker MCP, and the reply all the way back.
#
# WHY A SEPARATE TEST FROM byoc-tunnel.nix. That one asserts TRANSPORT -- a frame
# the container sends reaches every reader (the #737 fix). It deliberately has no
# agent-host, so nothing ever REPLIES to a tunnel open. That is the half where the
# production bug lives: mcpProxy sends open+end and then waits (mcpProxy.ts:132,
# "awaiting cloud reply"), and when no reply comes the agent burns a full 30s
# CONNECT_TIMEOUT and reports no MCP tools. A test that never waits for a reply
# cannot observe that, which is exactly why the transport test stayed green while
# scooter.chadac.me could not see the github tools.
#
# THE BUG SURFACE. scooter-broker is offered only when BOTH env gates are set
# (index.ts:1243): `brokerMcpUrl && convTokenSecret`. Miss either and the target is
# silently dropped -- the only trace is an info log, "broker MCP tools are NOT
# offered". The container then asks for a target the cloud refuses
# (tunnelService.ts:158) and the user sees an agent with no github tools.
#
# So this test pins the WIRING, not just the protocol: with both gates set the
# round trip completes, and with the secret missing the target is refused FAST
# rather than hanging. Both directions matter -- a silent drop and a hang look the
# same from the UI but need different fixes.

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
  # A HARD ceiling on the whole run. Every individual wait is bounded too, but this
  # catches the case none of them covers: something new that blocks forever.
  globalTimeout = 900;

  nodes = {
    # The broker: a fake MCP server that records what arrived, so the test can
    # assert the agent-host attached ITS OWN auth rather than forwarding the
    # container's headers (issue #700).
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
          # BOTH gates for scooter-broker (index.ts:1243). Dropping either is what
          # silently un-offers the target, so the test sets them explicitly and a
          # later subtest removes one on purpose.
          BROKER_MCP_URL = "http://broker:${toString BROKER_PORT}/mcp";
          CONV_TOKEN_SECRET = CONV_SECRET;
          BYOC_CONTROLLER_URL = "http://127.0.0.1:${toString CTRL_PORT}";
          # Gates the remote-personalized (BYOC) provider's very existence
          # (index.ts:713/724). Without it the provider is never built, so a run
          # silently falls to the cloud agent and NO tunnel client starts.
          REMOTE_AGENT_JOIN_SECRET = JOIN_SECRET;
          # No AGENT_HOST_DB_DSN: absent DSN is in-memory (index.ts:720), which keeps
          # this hermetic -- no Postgres to provision for a single-run test.
          BROKER_TOKEN_PATH = "/run/broker-token";
          # systemd units get NO $HOME, and goose refuses to start without one
          # (gooseConfig.ts:53, PR #524) -- it keeps its session db there.
          HOME = "/var/lib/agent-host";
          # One structured line per tunnel event (tunnelService.ts:60). Without it
          # the open/response/body trace is silent and a stalled stream looks
          # identical to a frame that never arrived.
          TUNNEL_TRACE = "1";
          # Mirrors the PROVEN fake-stack config (test/e2e/support/fakeBackend.mjs:168).
          # A fake agent + fake sandbox: no model API and no k8s to reconcile against,
          # which is what lets a BYOC run start in a bare VM. Without FAKE_SANDBOX the
          # k8s provisioner is selected and hydrate retries 5x against a cluster that
          # is not there.
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

      # The projected SA token kubelet would mount. A real file so the proxy's
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
    # EXPLICIT bounds everywhere. An exited service still satisfies
    # wait_for_unit, so an unbounded port wait hung a whole run for 11 minutes
    # with the real cause (a fatal config error) unread in the journal. Nothing
    # here waits forever, and every failure prints the journal.
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

    # Cross-host reachability FIRST, explicitly: a firewall problem downstream
    # looks exactly like a protocol bug in the logs.
    cloud.succeed("curl -sf http://broker:${toString BROKER_PORT}/healthz")
    laptop.succeed("curl -sf http://cloud:${toString CTRL_PORT}/healthz")

    laptop.succeed("cp ${fakeContainer} /tmp/container.py")

    OWNER = "alice"

    with subtest("the agent-host OFFERS scooter-broker when both gates are set"):
        # Miss BROKER_MCP_URL or CONV_TOKEN_SECRET and the target is dropped with
        # only an info log -- one of three gates that disable MCP silently.
        cloud.succeed(
            "journalctl -u agent-host --no-pager | "
            "grep -q 'broker MCP tools are NOT offered' && exit 1 || exit 0"
        )

    with subtest("a container attaches and the controller reports CONNECTED"):
        # eligible() requires status == "connected"; "minted" is NOT enough
        # (remoteAgentRegistry.ts:192), so the run would decline without this.
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
        # The owner is stamped HERE (management.ts:521) and it is the owner the
        # bridge later uses -- not the one on the prompt request.
        # x-auth-user, NOT x-auth-request-user: the latter is the byoc-controller's
        # ingress header. agent-host's default resolver reads x-auth-user
        # (identity.ts:142). An anonymous caller gets owner=undefined and the BYOC
        # provider declines.
        conv = json.loads(cloud.succeed(
            "curl -sf -X POST 'http://localhost:${toString HOST_PORT}/conversations' "
            f"-H 'x-auth-user: {OWNER}' -H 'content-type: application/json' -d '{{}}'"
        ))
        assert conv.get("id"), conv
        conv_id = conv["id"]

    with subtest("THE RUN: prompting selects BYOC and starts the tunnel client"):
        # The real path. POST /agui with NO `source` field: undefined counts as a
        # human trigger (remoteAgentRegistry.ts:33), which eligible() requires.
        #
        # No model API is involved. startTunnelClient runs inside createClient
        # (bridge.ts:1561), BEFORE initialize/newSession/prompt -- so a fake agent
        # and a fake container are enough to exercise the whole tunnel.
        #
        # SSE response, so this is bounded and the body is discarded; what matters
        # is the side effects asserted below.
        cloud.succeed(
            "timeout 30 curl -N -s -X POST 'http://localhost:${toString HOST_PORT}/agui' "
            f"-H 'x-auth-user: {OWNER}' -H 'content-type: application/json' "
            f"-d '{{\"threadId\":\"{conv_id}\",\"messages\":[{{\"role\":\"user\",\"content\":\"hi\"}}]}}' "
            "> /tmp/agui.out 2>&1 || true"
        )

        # PROOF the tunnel client started: it opens the controller's inbound stream
        # (tunnelClient.ts:44) and logs it. This is the line that was MISSING when
        # the frame was sent with no run in play.
        try:
            cloud.wait_until_succeeds(
                "journalctl -u agent-host --no-pager | grep -q 'following inbound stream'",
                timeout=60,
            )
        except Exception:
            cloud.execute("journalctl -u agent-host --no-pager | tail -60 >&2")
            cloud.execute("cat /tmp/agui.out >&2")
            raise

        # The BYOC provider was actually SELECTED, not the cloud floor.
        cloud.succeed(
            "journalctl -u agent-host --no-pager | grep -q 'SELECTED'"
        )

    with subtest("the ACP handshake REACHED the container over the relay"):
        # The container writes its report continuously, so even a hang leaves
        # evidence. initialize is the agent-host's first act on a new client.
        laptop.wait_until_succeeds("test -s /tmp/report.json", timeout=30)
        rep = json.loads(laptop.succeed("cat /tmp/report.json"))
        assert rep["connected"], rep
        # ACP rides a channel of its own: the agent-host POSTs each frame to
        # /byoc/:session/prompt (byocTransport.ts:17) and the controller relays it
        # over this socket, so `initialize` arriving here proves BOTH hops.
        assert rep.get("initialize_seen"), \
            f"the agent-host never sent ACP initialize — the run did not reach the container: {rep}"

    with subtest("the container is OFFERED scooter-broker, so the agent can see contrib tools"):
        # The payoff. The offer rides on new_session (bridge.ts:1589) and comes from
        # mcpServersFor -> offeredTunnelServers. An EMPTY offer is the production
        # symptom: the agent starts fine and simply has no github tools, with
        # nothing in the logs that looks like an error.
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
        # The step an OFFER assertion does not cover, and the one I had been
        # skipping: being offered `tunnel://scooter-broker` is a config string.
        # USING it means opening a tunnel stream, sending a JSON-RPC body and
        # reading chunks back until close -- where a 30s CONNECT_TIMEOUT or a
        # refused target actually appears.
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
        # A TIMEOUT here is the production symptom, so it must fail the test rather
        # than be tolerated: the budget is well under the 30s CONNECT_TIMEOUT.
        for c in broker_calls:
            assert c.get("reason") != "TIMEOUT", (
                f"MCP {c['method']} to scooter-broker TIMED OUT after {c['elapsed']}s "
                f"— this is the CONNECT_TIMEOUT hang"
            )
            assert c.get("ok"), f"MCP {c['method']} to scooter-broker failed: {c}"
            assert c["elapsed"] < 10, f"MCP {c['method']} took {c['elapsed']}s: {c}"

        # scooter-env too: asserting only the broker let a 406 on the other target
        # pass unnoticed for a full run.
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
        # Proves the hop reached the broker rather than being short-circuited, and
        # that the container's Bearer was REPLACED not forwarded (issue #700). This
        # assertion existed earlier and I dropped it in a rewrite; its absence is
        # why "MCP works" went unverified for several runs.
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
        # @chadac: "ensure you're testing multiple concurrent conversations have
        # proper isolation."
        #
        # THE #737 CLASS OF BUG, at the ACP layer. All of an owner's conversations
        # share ONE container session. The relay routes notifications by the
        # per-conversation acp sessionId (runRelay.ts:241); broadcasting instead --
        # the old behaviour -- "interleaved conversation A's transcript with B's and
        # had BOTH cloud sides execute the same tool call" (runRelay.ts:232).
        #
        # byoc-tunnel.nix covers the RAW-FRAME half (two readers, one session). This
        # covers the half above it: two real runs, each with its own acp session, and
        # a keyed session_update per prompt. Each conversation's SSE must carry only
        # its own text.
        # Restart the container holding TWO prompts before it answers either, so the
        # relay really has 2 candidate runs when it routes an update. With a
        # fast-acking container the runs serialise and a broadcast bug is invisible
        # -- the first version of this subtest passed even with routing disabled.
        # A SECOND container on its own session, holding two prompts before it
        # answers either, so the relay really has 2 candidate runs when it routes an
        # update. With a fast-acking container the runs serialise, candidates stays
        # at 1, and broadcast behaves exactly like routing -- the first version of
        # this subtest passed even with routing DISABLED.
        #
        # A fresh session rather than killing the first container: pkill -f matches
        # the shell running it and kills itself (exit 143).
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
        # Minting a new session REBINDS the owner, so status now tracks container 2.
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

        # Fire BOTH prompts concurrently: interleaving is the condition under test, so
        # a sequential pair would not exercise it.
        for i, cid in enumerate(convs):
            cloud.succeed(
                f"(setsid timeout 40 curl -N -s -X POST "
                f"'http://localhost:${toString HOST_PORT}/agui' "
                f"-H 'x-auth-user: {OWNER}' -H 'content-type: application/json' "
                f"-d '{{\"threadId\":\"{cid}\",\"messages\":"
                f"[{{\"role\":\"user\",\"content\":\"hi {i}\"}}]}}' "
                f"> /tmp/sse-{i}.out 2>&1 &) ; true"
            )

        # Both runs must finish. The container answers each prompt, so a stall here
        # means a frame went to the wrong run and one side is still waiting.
        for i in range(2):
            cloud.wait_until_succeeds(f"test -s /tmp/sse-{i}.out", timeout=60)
        cloud.wait_until_succeeds(
            "test $(journalctl -u agent-host --no-pager | "
            "grep -c 'acp prompt: returned') -ge 2",
            timeout=60,
        )

        # The container minted a DISTINCT acp session per conversation and notified
        # each one separately.
        rep = json.loads(laptop.succeed("cat /tmp/report2.json"))
        notified = rep.get("notified") or []
        print(f"acp sessions notified = {notified}")
        assert len(set(notified)) >= 2, \
            f"the two conversations shared one acp session — no isolation to test: {rep}"

        # ASSERT AT THE RELAY, not the SSE output. Isolation is DEFENCE IN DEPTH --
        # the relay routes by acpSessionId (runRelay.ts:241) AND the cloud bridge
        # drops foreign updates (bridge.ts:1609, "an update for a session we are not
        # driving must never be applied to our run"). An SSE assertion therefore
        # passes whenever EITHER layer holds: disabling relay routing left the
        # streams clean and this subtest green, which is how it was caught.
        #
        # So assert the relay's OWN contract: with 2 concurrent runs it must route
        # by key, never broadcast. The controller logs a warning the moment it
        # broadcasts an unkeyed frame across >1 run -- that line appearing means
        # a frame was delivered to a conversation it did not belong to.
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
