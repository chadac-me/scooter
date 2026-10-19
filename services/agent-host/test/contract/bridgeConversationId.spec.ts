/**
 * The bridge mints its own `sess-` id, but everything it hands a provider about the
 * conversation must carry the real conversation id: the RunContext, the per-provider MCP
 * set (a BYO agent's scooter-env token is minted for it) and the sandbox MCP resolver.
 * With the bridge's id instead, every scooter-env tool a remote agent called failed with
 * `no conversation sess-… for marimo`.
 */

import { describe, it, expect } from "vitest";

import { createSessionBridge } from "../../src/bridge.js";
import type { AcpProvider, RunContext } from "../../src/acp/provider.js";
import { createFakeAcpAgent } from "../fakes/fakeAcpAgent.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import { acpClientFromTransport } from "../fakes/acpClientFromTransport.js";

const CONVERSATION = "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff";

const BRIDGE_CONFIG = {
  cwd: "/workspace",
  skillsDir: "/skills",
  agent: { command: "fake", args: [], env: {} },
  sandbox: { name: "s", namespace: "ns" },
};

function oneTurnClient(exec: ReturnType<typeof createSandboxExecBackend>) {
  const agent = createFakeAcpAgent();
  agent.setScript([
    { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
    { finish: { stopReason: "end_turn" } },
  ]);
  return acpClientFromTransport(agent.transport, exec);
}

describe("bridge — the conversation id it hands providers", () => {
  it("gives a remote provider the real conversation id, not the bridge's sess- id", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const contexts: RunContext[] = [];
    const mcpFor: string[] = [];
    const remote: AcpProvider = {
      id: "remote-personalized",
      kind: "claude",
      priority: 10,
      eligible: (ctx) => (contexts.push(ctx), true),
      createClient: (ctx) => (contexts.push(ctx), oneTurnClient(exec)),
      mcpServersFor: (id) => (mcpFor.push(id), []),
    };

    const bridge = createSessionBridge({ conversationId: CONVERSATION, config: BRIDGE_CONFIG, exec, acpProviders: [remote] });
    await bridge.prompt({ threadId: CONVERSATION, text: "hi", source: "ui" });

    expect(bridge.sessionId).toMatch(/^sess-/);
    expect(contexts.length).toBeGreaterThan(0);
    for (const ctx of contexts) expect(ctx.conversationId, "RunContext.conversationId").toBe(CONVERSATION);
    expect(mcpFor, "the scooter-env token is minted for the conversation").toEqual([CONVERSATION]);

    await bridge.stop();
  });

  it("resolves the sandbox's MCP servers for the real conversation id", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const resolvedFor: string[] = [];
    const bridge = createSessionBridge({
      conversationId: CONVERSATION,
      config: BRIDGE_CONFIG,
      exec,
      acpClient: oneTurnClient(exec),
      resolveMcpServers: async (id) => (resolvedFor.push(id), []),
    });

    await bridge.prompt({ threadId: CONVERSATION, text: "one" });
    await bridge.prompt({ threadId: CONVERSATION, text: "two" });

    expect(resolvedFor.length, "resolved at session creation and re-checked per run").toBeGreaterThan(1);
    expect(new Set(resolvedFor)).toEqual(new Set([CONVERSATION]));

    await bridge.stop();
  });
});
