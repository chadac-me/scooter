/**
 * The BYO container gets its identity prompt over the wire.
 *
 * A BYO container shares nothing with this pod — not its filesystem, not the prompt the
 * in-pod SDK path builds locally — so the host must send the prompt in `new_session`
 * alongside the skills. Without it the container falls back to its own stub identity and
 * silently loses everything the prompt carries, the `<title>` contract included: that is
 * the regression this test exists to catch.
 */

import { describe, it, expect } from "vitest";

import { createSessionBridge } from "../../src/bridge.js";
import type { AcpProvider } from "../../src/acp/provider.js";
import type { NewSessionParams } from "../../src/acp/client.js";
import { createFakeAcpAgent } from "../fakes/fakeAcpAgent.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import { acpClientFromTransport } from "../fakes/acpClientFromTransport.js";
import { sdkPrompt } from "../../src/agent/skills.js";

const BRIDGE_CONFIG = {
  cwd: "/workspace",
  skillsDir: "/skills",
  agent: { command: "fake", args: [], env: {} },
  sandbox: { name: "s", namespace: "ns" },
  agentName: "Scooter",
};

/** A fake agent whose newSession params are captured for inspection. */
function makeCapturingAgent(exec: ReturnType<typeof createSandboxExecBackend>) {
  const agent = createFakeAcpAgent();
  agent.setScript([
    { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
    { finish: { stopReason: "end_turn" } },
  ]);
  const client = acpClientFromTransport(agent.transport, exec);
  let captured: NewSessionParams | undefined;
  const wrapped = new Proxy(client, {
    get(target, prop, recv) {
      if (prop === "newSession") {
        return (params: NewSessionParams) => {
          captured = params;
          return (target as unknown as { newSession: (p: NewSessionParams) => unknown }).newSession(params);
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
  return { client: wrapped, params: () => captured };
}

/** Run one turn through a single provider and return the newSession params it saw. */
async function newSessionParamsFor(provider: Omit<AcpProvider, "createClient">) {
  const exec = createSandboxExecBackend(createFakeSandboxApi());
  const agent = makeCapturingAgent(exec);
  const bridge = createSessionBridge({
    config: BRIDGE_CONFIG,
    exec,
    acpProviders: [{ ...provider, createClient: () => agent.client } as AcpProvider],
  });
  await bridge.prompt({ threadId: "t1", text: "hi", source: "ui" });
  return agent.params();
}

describe("new_session carries the identity prompt to a BYO container", () => {
  it("sends the SDK identity prompt to a BYO claude provider", async () => {
    const params = await newSessionParamsFor({
      id: "byoc-alice",
      kind: "claude",
      priority: 10,
      eligible: () => true,
    });
    expect(params?.systemPrompt, "a BYO container must be sent a prompt").toBeTruthy();
    expect(params?.systemPrompt).toBe(sdkPrompt({ name: "Scooter" }));
  });

  it("that prompt carries the <title> contract, which is how a BYO conversation gets named", async () => {
    const params = await newSessionParamsFor({
      id: "byoc-alice",
      kind: "claude",
      priority: 10,
      eligible: () => true,
    });
    // The marker instruction, not just any prompt: the container emits <title> only if told to.
    expect(params?.systemPrompt).toContain("<title>");
  });

  it("honours the deployment's agent name rather than hardcoding one", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const agent = makeCapturingAgent(exec);
    const bridge = createSessionBridge({
      config: { ...BRIDGE_CONFIG, agentName: "Rover" },
      exec,
      acpProviders: [
        { id: "byoc-alice", kind: "claude", priority: 10, eligible: () => true, createClient: () => agent.client },
      ],
    });
    await bridge.prompt({ threadId: "t1", text: "hi", source: "ui" });
    expect(agent.params()?.systemPrompt).toContain("You are Rover");
  });

  it("sends NO prompt to the in-pod sdk-claude provider, which builds its own", async () => {
    const params = await newSessionParamsFor({
      id: "sdk-claude",
      kind: "claude",
      priority: 10,
      eligible: () => true,
    });
    expect(params?.systemPrompt, "the in-pod SDK path owns its prompt").toBeUndefined();
  });

  it("sends NO prompt to a goose provider, which reads .goosehints from this pod", async () => {
    const params = await newSessionParamsFor({
      id: "floor",
      kind: "goose",
      priority: 0,
      eligible: () => true,
    });
    expect(params?.systemPrompt).toBeUndefined();
  });
});
