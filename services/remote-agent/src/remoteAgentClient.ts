/**
 * RemoteAgentClient, the container's core. It dials the cloud WS, sends the hello, then
 * bridges Channel A to a local SdkAcpClient: ACP requests from the cloud drive the local
 * Claude, its updates and permission requests go back up, and its tool calls tunnel to
 * the cloud sandbox over Channel B. The Claude subscription token stays local.
 */

import { WebSocket } from "ws";
import { pruneSkillDirs, writeSkillPayloads } from "./skills.js";
// The SDK-backed AcpClient, the same package the agent-host imports cloud-side.
import { selectBackend } from "./agentBackend.js";
import "./echoBackend.js"; // self-registers

import { REMOTE_PROTOCOL_VERSION, type WireFrame } from "./protocol.js";
import { parsePermissionAnswer } from "./permissionAnswer.js";
import { nextReconnectDelay, closeDisposition } from "./reconnect.js";
import { loadDeviceIdentity, signChallenge } from "./deviceKey.js";
import { createTunnelExecBackend } from "./tunnelExec.js";
import { startMcpProxies } from "./mcpProxy.js";

export interface RemoteAgentClientDeps {
  /** wss URL (…/remote-agent/connect). */
  url: string;
  /** Owner-bound join token from the UI one-liner, used once to register this device. */
  joinToken: string;
  /** Fetch a fresh challenge nonce from the controller; absent means token-only mode. */
  challengeNonce?: () => Promise<string>;
  /** The user's Claude subscription OAuth token, which stays local. Absent for a
   *  backend that needs no Claude auth (see selectBackend). */
  oauthToken?: string;
  /** Which agent to drive; defaults to the Claude SDK. */
  backend?: string;
  /** Model for the SDK query(). */
  model?: string;
  /** Agent identity/skills as the system prompt. */
  systemPrompt?: string;
  /** Path to a glibc `claude` CLI. */
  claudeCodePath?: string;
  /** Log sink, defaulting to console. */
  log?: (msg: string) => void;
}

export interface RemoteAgentClient {
  /** Resolves when the connection closes and reconnect attempts stop. */
  closed: Promise<void>;
  stop(): void;
}

/**
 * The WS URL to dial, carrying whatever credential this container has: a registered
 * device signs a fresh server nonce, and a first-time container falls back to the join
 * token. Both travel as query params because the controller authorizes the upgrade
 * itself, before any message exists.
 */
export async function buildConnectUrl(deps: RemoteAgentClientDeps): Promise<string> {
  const url = new URL(deps.url);
  const identity = await loadDeviceIdentity();
  if (identity && deps.challengeNonce) {
    try {
      const nonce = await deps.challengeNonce();
      url.searchParams.set("deviceId", identity.deviceId);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("signature", signChallenge(identity.privateKeyPem, nonce));
      return url.toString();
    } catch {
      // No challenge endpoint reachable: fall back to the join token for this attempt.
    }
  }
  if (deps.joinToken) url.searchParams.set("token", deps.joinToken);
  return url.toString();
}

export function runRemoteAgentClient(deps: RemoteAgentClientDeps): RemoteAgentClient {
  const log = deps.log ?? ((m: string) => console.log(`[remote-agent] ${m}`));
  let stopped = false;
  let attempt = 0;
  let ws: WebSocket | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));

  const connect = async () => {
    if (stopped) return;
    // The controller authorizes at the upgrade, so credentials must ride on the URL.
    const connectUrl = await buildConnectUrl(deps);
    ws = new WebSocket(connectUrl);
    const frameCbs = new Set<(f: WireFrame) => void>();
    const send = (f: WireFrame) => {
      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(f));
        return;
      }
      // A dropped frame must be logged, or an MCP call becomes a silent 30s timeout.
      log(`DROPPED ${f.ch}/${f.type} frame — socket ${ws ? "state " + ws.readyState : "absent"}`);
    };

    // Permission answers route by unique frame id, so one shared waiter map serves every per-session client.
    const permissionWaiters = new Map<string, (ans: { optionId: string } | { cancelled: true }) => void>();

    /** Build one SDK-backed brain per ACP session, stamping its outbound frames with the session id (known only after newSession returns) so the relay can route concurrent conversations on one container. */
    const buildClient = async (
      model?: string,
      mcpServers?: Array<{ name?: string }>,
      skills?: ReadonlyArray<{ name: string; content: string }>,
    ) => {
      const stamp: { sid?: string } = {};
      const stampedSend = (f: WireFrame) => send(stamp.sid ? { ...f, sid: stamp.sid } : f);
      const exec = createTunnelExecBackend({
        send: stampedSend,
        onFrame: (cb) => {
          frameCbs.add(cb);
          return () => frameCbs.delete(cb);
        },
      });
      // Start a local proxy per offered MCP server (they live on the agent-host's loopback) and write the cloud-sent skills locally so the SDK discovers them.
      let skillCwd: string | undefined;
      if (skills?.length) {
        // Skills are an enhancement, so a write failure must not take the conversation down.
        try {
          const { mkdtempSync, mkdirSync } = await import("node:fs");
          const { join } = await import("node:path");
          // This image has no /tmp, so use the mounted config dir and create the parent.
          const parent = join(process.env.CLAUDE_CONFIG_DIR ?? "/root/.claude", "sessions");
          mkdirSync(parent, { recursive: true });
          // The volume is persistent, so keep only the most recent few session dirs.
          pruneSkillDirs(parent, 5);
          skillCwd = mkdtempSync(join(parent, "skills-"));
          const written = writeSkillPayloads(skillCwd, skills);
          log(`skills: wrote ${written} to ${skillCwd}/.claude/skills`);
        } catch (err) {
          skillCwd = undefined;
          log(`skills: NOT available (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      const offered = (mcpServers ?? []).filter((m): m is { name: string } => typeof m?.name === "string");
      const mcp = offered.length
        ? await startMcpProxies(offered, {
            send: stampedSend,
            onFrame: (cb) => {
              frameCbs.add(cb);
              return () => frameCbs.delete(cb);
            },
            sessionId: undefined, // set below once newSession returns (stamp.sid)
            trace: (m) => log(`mcp ${m}`),
          })
        : undefined;
      if (mcp) log(`MCP: ${mcp.servers.map((s) => s.name).join(", ")} proxied over the tunnel`);
      // The backend decides WHICH agent runs; every one returns the same AcpClient.
      const sdk = await selectBackend(deps.backend).create({
        oauthToken: deps.oauthToken,
        mcpServers: mcp?.servers.map((m) => ({ name: m.name, url: m.url })),
        // The per-session model sent by the cloud in new_session, then the container's --model flag.
        model: model ?? deps.model,
        exec,
        systemPrompt: deps.systemPrompt,
        claudeCodePath: deps.claudeCodePath,
        // Without settingSources the SDK loads no filesystem settings, and without `skills` the Skill tool is left out of allowedTools.
        ...(skillCwd ? { cwd: skillCwd, settingSources: ["project" as const], skills: "all" as const } : {}),
        log: deps.log,
      });
      // Route the SDK's notifications up the wire, stamped.
      sdk.onSessionUpdate((sessionId, update) =>
        send({ ch: "acp", type: "session_update", sid: sessionId, payload: { sessionId, update } }));
      sdk.onTerminalCreated((terminalId, command, args) => stampedSend({ ch: "acp", type: "terminal_created", payload: { terminalId, command, args } }));
      sdk.onPermissionRequest((req) => {
        return new Promise<{ optionId: string } | { cancelled: true }>((resolve) => {
          const id = req.toolCallId + ":" + Math.random().toString(36).slice(2);
          permissionWaiters.set(id, resolve);
          send({ ch: "acp", type: "permission_request", id, sid: req.sessionId, payload: { request: req } });
        });
      });
      return { sdk, stamp, closeMcp: mcp?.close };
    };

    // The primary client answers `initialize`, which precedes any session; every `new_session` gets its own client.
    const primary = await buildClient();
    const sdk = primary.sdk;
    const clients = new Map<string, { sdk: typeof primary.sdk; stamp: { sid?: string }; closeMcp?: () => Promise<void> }>();

    ws.on("open", () => {
      void (async () => {
        attempt = 0; // a successful connect resets the backoff window
        // Auth already happened at the upgrade; the hello only negotiates the protocol version.
        ws!.send(JSON.stringify({ protocolVersion: REMOTE_PROTOCOL_VERSION, joinToken: deps.joinToken }));
      })();
    });

    ws.on("message", (data) => {
      let frame: WireFrame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      // Server confirmations.
      if (frame.type === "connected") {
        log(`registered as owner ${(frame.payload as { owner?: string })?.owner ?? "?"} — ready`);
        return;
      }
      // Channel B exec_result frames go to the tunnel backend's waiters.
      if (frame.ch === "exec") {
        for (const cb of frameCbs) cb(frame);
        return;
      }
      // MCP replies; without this every call hangs.
      if (frame.ch === "tunnel") {
        for (const cb of frameCbs) cb(frame);
        return;
      }
      // Channel A: drive the SDK.
      if (frame.ch === "acp") void handleAcp(frame);
    });

    const ack = (id: string | undefined, result: unknown, error?: string) => {
      if (id) send({ ch: "acp", type: "ack", id, payload: error ? { error } : { result } });
    };

    const handleAcp = async (frame: WireFrame) => {
      try {
        switch (frame.type) {
          case "initialize": {
            const r = await sdk.initialize((frame.payload as { params: never }).params);
            return ack(frame.id, r);
          }
          case "new_session": {
            // The returned session id becomes both the routing key for later prompts and the sid stamped on this client's tool frames.
            const params = (frame.payload as {
              params?: {
                model?: string;
                mcpServers?: Array<{ name?: string }>;
                skills?: Array<{ name: string; content: string }>;
              };
            })?.params;
            const client = await buildClient(params?.model, params?.mcpServers, params?.skills);
            const r = await client.sdk.newSession((frame.payload as { params: never }).params);
            const sid = (r as { sessionId?: string }).sessionId;
            if (sid) {
              client.stamp.sid = sid;
              clients.set(sid, client);
            }
            log(`new_session -> acp session ${sid ?? "?"}`);
            return ack(frame.id, r);
          }
          case "prompt": {
            const p = frame.payload as { sessionId: string; prompt: Array<{ type?: string; text?: string }> };
            // Log the prompt so it is provable from the outside that this container served the turn.
            const preview = (p.prompt ?? [])
              .map((b) => (typeof b?.text === "string" ? b.text : ""))
              .join(" ")
              .replace(/\s+/g, " ")
              .slice(0, 80);
            log(`prompt acp-session=${p.sessionId} text="${preview}"`);
            const started = Date.now();
            // A session id this instance never issued means the container restarted since the cloud established it; refusing lets the cloud re-establish the session here.
            const owner = clients.get(p.sessionId)?.sdk;
            if (!owner) {
              log(`prompt for unknown acp-session=${p.sessionId} — refusing (container restarted since it was created)`);
              return ack(frame.id, undefined, `unknown session ${p.sessionId} (container restarted)`);
            }
            const r = await owner.prompt({ sessionId: p.sessionId, prompt: p.prompt as never });
            log(`prompt DONE acp-session=${p.sessionId} stopReason=${(r as { stopReason?: string }).stopReason ?? "?"} in ${Date.now() - started}ms`);
            return ack(frame.id, r);
          }
          case "cancel": {
            // Cancelling a session this instance never issued is a no-op success.
            const sid = (frame.payload as { sessionId: string }).sessionId;
            await clients.get(sid)?.sdk.cancel(sid);
            return ack(frame.id, {});
          }
          case "kill_terminals": {
            // The cloud does not say which session's terminals, so kill across every client.
            await Promise.all([sdk, ...[...clients.values()].map((c) => c.sdk)].map((c) => c.killActiveTerminals().catch(() => {})));
            return ack(frame.id, {});
          }
          case "ack": {
            // A permission answer to our permission_request id; parsePermissionAnswer fails closed on anything unrecognised.
            const w = frame.id ? permissionWaiters.get(frame.id) : undefined;
            if (w && frame.id) {
              permissionWaiters.delete(frame.id);
              w(parsePermissionAnswer(frame.payload));
            }
            return;
          }
        }
      } catch (err) {
        ack(frame.id, undefined, err instanceof Error ? err.message : String(err));
      }
    };

    // Set when the upgrade itself was rejected, so the meaningless 1006 close that follows terminate() takes the auth disposition.
    let upgradeAuthRejected = false;
    ws.on("close", (code, reasonBuf) => {
      // The controller uses application close codes for conditions a container must react to differently than a network blip.
      const disposition = upgradeAuthRejected
        ? closeDisposition(4001, "rejected at the WebSocket upgrade (HTTP 401)", attempt + 1)
        : closeDisposition(code, reasonBuf?.toString() ?? "", attempt + 1);
      if (!upgradeAuthRejected) log(disposition.message ?? `disconnected (code ${code})`);
      // Cancel every parked permission, or the local SDK waits forever on an approval that can never arrive.
      for (const [id, waiter] of [...permissionWaiters]) {
        permissionWaiters.delete(id);
        waiter({ cancelled: true });
      }
      void sdk.close().catch(() => {});
      for (const c of clients.values()) {
        void c.sdk.close().catch(() => {});
        // A stale proxy pointing at a dead session would hang the SDK instead of failing it.
        void c.closeMcp?.().catch(() => {});
      }
      clients.clear();
      if (stopped) {
        resolveClosed();
        return;
      }
      // Exponential backoff with jitter (see reconnect.ts).
      attempt += 1;
      const delay = disposition.delayMs;
      log(`reconnecting in ${delay}ms (attempt ${attempt})`);
      setTimeout(() => void connect(), delay);
    });
    // A non-101 upgrade response, which the ws lib would otherwise surface as a generic error.
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) {
        upgradeAuthRejected = true;
        log(
          "AUTHENTICATION FAILED: the server rejected this container's credentials at the upgrade " +
            "(HTTP 401). This will not fix itself — get a fresh docker command from the Settings page.",
        );
      } else {
        log(`unexpected server response ${res.statusCode ?? "?"} during connect`);
      }
      // terminate() fires the close handler, which schedules the retry.
      ws?.terminate();
    });
    ws.on("error", (e) => log(`ws error: ${(e as Error).message}`));
  };

  void connect();
  return {
    closed,
    stop() {
      stopped = true;
      ws?.close();
    },
  };
}
