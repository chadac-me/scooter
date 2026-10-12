/**
 * History reinjection is per ACP session, not per bridge: any session's first prompt in
 * a conversation carries the transcript (a provider switch or container restart creates
 * a new session that needs it), and a session that already saw it never gets it twice.
 */

import { describe, it, expect } from "vitest";

import { createSessionBridge } from "../../src/bridge.js";
import type { AcpProvider } from "../../src/acp/provider.js";
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

/** A fake agent whose client records the prompt content blocks it receives. */
function recordingAgent(exec: ReturnType<typeof createSandboxExecBackend>) {
  const agent = createFakeAcpAgent();
  agent.setScript([
    { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
    { finish: { stopReason: "end_turn" } },
  ]);
  const client = acpClientFromTransport(agent.transport, exec);
  const prompts: Array<Array<{ type?: string; text?: string }>> = [];
  const wrapped = new Proxy(client, {
    get(target, prop, recv) {
      if (prop === "prompt") {
        return (params: { prompt: Array<{ type?: string; text?: string }> }) => {
          prompts.push(params.prompt);
          return (target as unknown as { prompt: (p: unknown) => unknown }).prompt(params);
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
  return { client: wrapped, prompts };
}

const priorLog: AguiEvent[] = [
  { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" } as never,
  { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "add a readme" } as never,
  { type: "TEXT_MESSAGE_END", messageId: "u1" } as never,
  { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" } as never,
  { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "done, added README.md" } as never,
  { type: "TEXT_MESSAGE_END", messageId: "a1" } as never,
];

describe("history reinjection is per ACP session", () => {
  it("THE GAP: a provider switch mid-conversation seeds the NEW session too", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const floor = recordingAgent(exec);
    const personalized = recordingAgent(exec);

    let containerOnline = false;
    const providers: AcpProvider[] = [
      { id: "personalized", kind: "claude", priority: 10, eligible: () => containerOnline, createClient: () => personalized.client },
      { id: "floor", kind: "goose", priority: 0, eligible: () => true, createClient: () => floor.client },
    ];

    const bridge = createSessionBridge({
      config: BRIDGE_CONFIG, exec, acpProviders: providers,
      loadHistory: async () => priorLog,
    });

    await bridge.prompt({ threadId: "t1", text: "first", source: "ui" });
    expect(floor.prompts[0].some((b) => (b.text ?? "").includes("add a readme")),
      "run 1 (floor session's first prompt) carries the transcript").toBe(true);

    containerOnline = true;
    await bridge.prompt({ threadId: "t1", text: "second", source: "ui" });
    expect(personalized.prompts, "run 2 went to the container").toHaveLength(1);
    expect(personalized.prompts[0].some((b) => (b.text ?? "").includes("add a readme")),
      "the container's FIRST prompt must carry the transcript — it has never seen this conversation").toBe(true);
    // The current turn must not be duplicated into the preamble.
    const preamble = personalized.prompts[0].map((b) => b.text ?? "").join("\n");
    expect((preamble.match(/second/g) ?? []).length).toBe(1);
  });

  it("the SAME session is never seeded twice", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const agent = recordingAgent(exec);
    const bridge = createSessionBridge({
      config: BRIDGE_CONFIG, exec, acpClient: agent.client,
      loadHistory: async () => priorLog,
    });
    await bridge.prompt({ threadId: "t1", text: "first" });
    await bridge.prompt({ threadId: "t1", text: "second" });
    expect(agent.prompts[0].some((b) => (b.text ?? "").includes("add a readme"))).toBe(true);
    expect(agent.prompts[1].some((b) => (b.text ?? "").includes("add a readme")),
      "same session remembers — re-seeding would duplicate the transcript").toBe(false);
  });
});
