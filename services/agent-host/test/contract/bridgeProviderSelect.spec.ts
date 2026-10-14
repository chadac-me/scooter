/**
 * The bridge resolves its ACP client per run via the provider registry: with two
 * providers configured, each run goes to the provider whose eligible() matches that
 * run's `source`.
 */

import { describe, it, expect } from "vitest";

import { createSessionBridge } from "../../src/bridge.js";
import type { AcpProvider } from "../../src/acp/provider.js";
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

/** A fake ACP agent that counts the prompts it received and emits a one-chunk turn. */
function makeCountingAgent(exec: ReturnType<typeof createSandboxExecBackend>) {
  const agent = createFakeAcpAgent();
  agent.setScript([
    { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
    { finish: { stopReason: "end_turn" } },
  ]);
  const client = acpClientFromTransport(agent.transport, exec);
  let prompts = 0;
  const wrapped = new Proxy(client, {
    get(target, prop, recv) {
      if (prop === "prompt") {
        return (...args: unknown[]) => {
          prompts++;
          return (target as unknown as { prompt: (...a: unknown[]) => unknown }).prompt(...args);
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
  return { client: wrapped, prompts: () => prompts };
}

describe("bridge — per-run provider selection", () => {
  it("routes each run to the provider eligible for that run's source", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const humanAgent = makeCountingAgent(exec);
    const floorAgent = makeCountingAgent(exec);

    // "personalized" is eligible only for human sources; "floor" is always eligible at lower priority.
    const HUMAN = new Set(["ui", "slack", "github", "gitlab"]);
    const providers: AcpProvider[] = [
      {
        id: "personalized",
        kind: "claude",
        priority: 10,
        eligible: (ctx) => HUMAN.has(ctx.source ?? ""),
        createClient: () => humanAgent.client,
      },
      {
        id: "floor",
        kind: "goose",
        priority: 0,
        eligible: () => true,
        createClient: () => floorAgent.client,
      },
    ];

    const bridge = createSessionBridge({ config: BRIDGE_CONFIG, exec, acpProviders: providers });

    // A human-sourced run goes to personalized.
    await bridge.prompt({ threadId: "t1", text: "hi", source: "slack" });
    expect(humanAgent.prompts(), "human source routes to personalized").toBe(1);
    expect(floorAgent.prompts()).toBe(0);

    // A scheduled run on the same conversation falls to the floor.
    await bridge.prompt({ threadId: "t1", text: "cron", source: "scheduler" });
    expect(humanAgent.prompts(), "scheduled run must NOT hit personalized").toBe(1);
    expect(floorAgent.prompts(), "scheduled run routes to the floor").toBe(1);

    // Back to a human source, personalized again, since selection is per run rather than sticky.
    await bridge.prompt({ threadId: "t1", text: "again", source: "ui" });
    expect(humanAgent.prompts()).toBe(2);
    expect(floorAgent.prompts()).toBe(1);

    await bridge.stop();
  });
});
