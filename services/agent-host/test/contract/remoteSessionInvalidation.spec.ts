/**
 * A remote session that died with a container restart is re-established rather than
 * served blank: when a remote prompt fails with "unknown session", the bridge drops that
 * provider's cached session and retries the run once, creating a session on the current
 * container instance, whose new key makes the history reinjection fire again.
 */

import { describe, it, expect } from "vitest";

import { createSessionBridge } from "../../src/bridge.js";
import type { AguiEvent } from "../../src/bridge.js";
import { createFakeAcpAgent } from "../fakes/fakeAcpAgent.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import { acpClientFromTransport } from "../fakes/acpClientFromTransport.js";

const BRIDGE_CONFIG = {
  cwd: "/workspace",
  skillsDir: "/skills",
  agent: { command: "fake", args: [], env: {} },
  sandbox: { name: "s", namespace: "ns" },
};

const priorLog: AguiEvent[] = [
  { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" } as never,
  { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "the earlier work" } as never,
  { type: "TEXT_MESSAGE_END", messageId: "u1" } as never,
];

/** Clients whose first generation rejects prompts with "unknown session", modelling the old container's dead session. */
function makeAgents() {
  const exec = createSandboxExecBackend(createFakeSandboxApi());
  let instances = 0;
  const prompts: Array<Array<{ text?: string }>> = [];
  let newSessions = 0;
  const createClient = () => {
    instances += 1;
    const generation = instances;
    const agent = createFakeAcpAgent();
    agent.setScript([
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
      { finish: { stopReason: "end_turn" } },
    ]);
    const client = acpClientFromTransport(agent.transport, exec);
    return new Proxy(client, {
      get(target, prop, recv) {
        if (prop === "newSession") {
          return (p: unknown) => {
            newSessions += 1;
            return (target as never as { newSession: (x: unknown) => unknown }).newSession(p);
          };
        }
        if (prop === "prompt") {
          return (params: { prompt: Array<{ text?: string }> }) => {
            // Generation 1 is the stale cached session the restarted container no longer knows.
            if (generation === 1) return Promise.reject(new Error("unknown session sdk_stale (container restarted?)"));
            prompts.push(params.prompt);
            return (target as never as { prompt: (x: unknown) => unknown }).prompt(params);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
  };
  return { exec, createClient, prompts, counts: () => ({ instances, newSessions }) };
}

describe("remote session invalidation", () => {
  it("an 'unknown session' prompt failure re-establishes the session AND re-seeds history", async () => {
    const a = makeAgents();
    const bridge = createSessionBridge({
      config: BRIDGE_CONFIG,
      exec: a.exec,
      acpClient: () => Promise.resolve(a.createClient()),
      loadHistory: async () => priorLog,
      deathRetryBaseMs: 5,
    });

    const events: AguiEvent[] = [];
    bridge.onEvent((e) => events.push(e));
    await bridge.prompt({ threadId: "t1", text: "continue please" });

    // The retry created a second client and session.
    expect(a.counts().instances).toBe(2);
    expect(a.counts().newSessions).toBe(2);
    // Its prompt carried the transcript again.
    expect(a.prompts).toHaveLength(1);
    expect(a.prompts[0].some((b) => (b.text ?? "").includes("the earlier work")),
      "the fresh session must be re-seeded — serving it blank is the amnesia bug").toBe(true);
    // The pump emits RUN_ERROR + RUN_RETRYING for the failed attempt, but the last terminal is a normal finish.
    const terminals = events.filter((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR");
    expect(terminals[terminals.length - 1]?.type).toBe("RUN_FINISHED");
  });

  it("a NON-session error retries on the SAME session — no session churn", async () => {
    // The pump's backoff handles transient failures without invalidating a healthy session.
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    let clients = 0;
    let attempts = 0;
    const factory = () => {
      clients += 1;
      const agent = createFakeAcpAgent();
      const client = acpClientFromTransport(agent.transport, exec);
      return Promise.resolve(new Proxy(client, {
        get(target, prop, recv) {
          if (prop === "prompt") {
            return () => {
              attempts += 1;
              return Promise.reject(new Error("model overloaded"));
            };
          }
          return Reflect.get(target, prop, recv);
        },
      }));
    };
    const bridge = createSessionBridge({
      config: BRIDGE_CONFIG, exec, acpClient: factory, deathRetryBaseMs: 5,
    });
    await bridge.prompt({ threadId: "t1", text: "hi" }).catch(() => undefined);
    expect(attempts).toBeGreaterThan(1);
    expect(clients).toBe(1);
  });
});
