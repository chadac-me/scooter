/**
 * The agent's identity travels with `new_session` when the provider says it must.
 *
 * A BYO container shares nothing with this pod — not its filesystem, not the prompt the
 * in-pod SDK path builds locally — so it declares `needsSystemPrompt`/`needsSkillPayloads`
 * and the host sends both. Without the prompt the container falls back to its own stub
 * identity and silently loses everything the prompt carries, the `<title>` contract
 * included: that is the regression this test exists to catch. In-pod providers declare
 * neither and must be sent neither, since they build their own.
 */

import { describe, it, expect } from "vitest";

import { createSessionBridge } from "../../src/bridge.js";
import { createRemotePersonalizedProvider } from "../../src/acp/remoteAgentRegistry.js";
import type { AcpProvider } from "../../src/acp/provider.js";
import type { NewSessionParams } from "../../src/acp/client.js";
import type { ExecBackend } from "../../src/types.js";
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
async function newSessionParamsFor(
  provider: Omit<AcpProvider, "createClient">,
  config: Partial<typeof BRIDGE_CONFIG> = {},
) {
  const exec = createSandboxExecBackend(createFakeSandboxApi());
  const agent = makeCapturingAgent(exec);
  const bridge = createSessionBridge({
    config: { ...BRIDGE_CONFIG, ...config },
    exec,
    acpProviders: [{ ...provider, createClient: () => agent.client } as AcpProvider],
  });
  await bridge.prompt({ threadId: "t1", text: "hi", source: "ui" });
  return agent.params();
}

/** A provider that owns nothing locally, the way a BYO container's does. */
const BYO = {
  id: "byoc-alice",
  kind: "claude",
  priority: 10,
  needsSystemPrompt: true,
  needsSkillPayloads: true,
  eligible: () => true,
} as const satisfies Omit<AcpProvider, "createClient">;

describe("new_session carries the identity a provider cannot build itself", () => {
  it("sends the SDK identity prompt to a provider that needs one", async () => {
    const params = await newSessionParamsFor(BYO);
    expect(params?.systemPrompt, "a BYO container must be sent a prompt").toBeTruthy();
    expect(params?.systemPrompt).toBe(sdkPrompt({ name: "Scooter" }));
  });

  it("that prompt carries the <title> contract, which is how a BYO conversation gets named", async () => {
    const params = await newSessionParamsFor(BYO);
    // The marker instruction, not just any prompt: the container emits <title> only if told to.
    expect(params?.systemPrompt).toContain("<title>");
  });

  it("honours the deployment's agent name rather than hardcoding one", async () => {
    const params = await newSessionParamsFor(BYO, { agentName: "Rover" });
    expect(params?.systemPrompt).toContain("You are Rover");
  });

  it("sends the skills as data to a provider that cannot read this pod's skillsDir", async () => {
    const params = await newSessionParamsFor(BYO);
    expect(params?.skills, "the container writes its own .claude/skills from these").toBeDefined();
  });

  it("sends NEITHER to an in-pod provider, which owns its prompt and reads skillsDir itself", async () => {
    // The defaults: the floor providers (sdk-claude, bedrock-goose) declare no needs.
    const sdk = await newSessionParamsFor({ id: "sdk-claude", kind: "claude", priority: 0, eligible: () => true });
    expect(sdk?.systemPrompt, "the in-pod SDK path owns its prompt").toBeUndefined();
    expect(sdk?.skills).toBeUndefined();
    const goose = await newSessionParamsFor({ id: "bedrock-goose", kind: "goose", priority: 0, eligible: () => true });
    expect(goose?.systemPrompt).toBeUndefined();
    expect(goose?.skills).toBeUndefined();
  });

  it("the real remote-personalized provider declares both needs", () => {
    // The flags are the whole fix, so the shipped BYO provider must actually carry them.
    const provider = createRemotePersonalizedProvider({
      controllerUrl: "http://controller:8080",
      exec: {} as ExecBackend,
    });
    expect(provider.needsSystemPrompt).toBe(true);
    expect(provider.needsSkillPayloads).toBe(true);
  });
});
