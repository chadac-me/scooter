/**
 * The bridge rebuilds its agent session when the conversation's skills change and leaves
 * it alone when they do not. Every provider reads skills only at session start (a BYO
 * container gets them on new_session), and a skills-only deploy edits the ConfigMap
 * without restarting agent-host, so a live conversation would otherwise keep the old set.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionBridge } from "../../src/bridge.js";
import type { AcpProvider } from "../../src/acp/provider.js";
import type { Skill } from "../../src/agent/skills.js";
import { createFakeAcpAgent } from "../fakes/fakeAcpAgent.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import { acpClientFromTransport } from "../fakes/acpClientFromTransport.js";

type Payload = { name: string; content: string };

let skillsDir: string;
beforeEach(() => {
  skillsDir = mkdtempSync(join(tmpdir(), "skills-rebuild-"));
  mkdirSync(skillsDir, { recursive: true });
});
afterEach(() => rmSync(skillsDir, { recursive: true, force: true }));

const writeSkill = (name: string, body: string) =>
  writeFileSync(join(skillsDir, `${name}.md`), `---\ndescription: ${name}\n---\n\n${body}\n`, "utf8");

/** A BYO-shaped provider recording the skills each newSession carried, with a fresh fake agent per client. */
function recordingProvider(exec: ReturnType<typeof createSandboxExecBackend>) {
  const sessions: Payload[][] = [];
  let clients = 0;
  const provider: AcpProvider = {
    id: "byo",
    kind: "claude",
    priority: 0,
    needsSkillPayloads: true,
    eligible: () => true,
    createClient: () => {
      clients++;
      const agent = createFakeAcpAgent();
      agent.setScript([
        { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
        { finish: { stopReason: "end_turn" } },
      ]);
      const client = acpClientFromTransport(agent.transport, exec);
      return new Proxy(client, {
        get(target, prop, recv) {
          if (prop === "newSession") {
            return async (params: { skills?: Payload[] }) => {
              sessions.push(params.skills ?? []);
              return (target as unknown as { newSession: (p: unknown) => Promise<{ sessionId: string }> })
                .newSession(params);
            };
          }
          return Reflect.get(target, prop, recv);
        },
      });
    },
  };
  return { provider, sessions: () => sessions, clients: () => clients };
}

const bridgeFor = (provider: AcpProvider, exec: ReturnType<typeof createSandboxExecBackend>, personal?: () => Promise<Skill[]>) =>
  createSessionBridge({
    config: { cwd: "/workspace", skillsDir, agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
    exec,
    acpProviders: [provider],
    personalSkills: personal,
  });

describe("bridge — skills change under a live conversation", () => {
  it("rebuilds the session with the new set when a deploy edits the skills", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const rec = recordingProvider(exec);
    writeSkill("alpha", "v1");
    const bridge = bridgeFor(rec.provider, exec);

    await bridge.prompt({ threadId: "t1", text: "one" });
    writeSkill("alpha", "v2");
    writeSkill("beta", "new");
    await bridge.prompt({ threadId: "t1", text: "two" });

    expect(rec.clients(), "a changed set must create a NEW client").toBe(2);
    const second = rec.sessions()[1];
    expect(second.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(second[0].content).toContain("v2");

    await bridge.stop();
  });

  it("rebuilds when the owner's personal skills change", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const rec = recordingProvider(exec);
    let personal: Skill[] = [];
    const bridge = bridgeFor(rec.provider, exec, async () => personal);

    await bridge.prompt({ threadId: "t1", text: "one" });
    personal = [{ name: "mine", text: "my body", description: "mine" }];
    await bridge.prompt({ threadId: "t1", text: "two" });

    expect(rec.clients()).toBe(2);
    expect(rec.sessions()[1].map((s) => s.name)).toEqual(["mine"]);

    await bridge.stop();
  });

  it("does NOT rebuild when the skills are unchanged", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const rec = recordingProvider(exec);
    writeSkill("alpha", "v1");
    const bridge = bridgeFor(rec.provider, exec);

    await bridge.prompt({ threadId: "t1", text: "one" });
    await bridge.prompt({ threadId: "t1", text: "two" });

    expect(rec.clients(), "an unchanged set must reuse the session").toBe(1);

    await bridge.stop();
  });

  it("keeps the current session when the skills cannot be read", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const rec = recordingProvider(exec);
    let fail = false;
    const bridge = bridgeFor(rec.provider, exec, async () => {
      if (fail) throw new Error("db down");
      return [];
    });

    await bridge.prompt({ threadId: "t1", text: "one" });
    fail = true;
    await bridge.prompt({ threadId: "t1", text: "two" });

    expect(rec.clients(), "a read failure must not rebuild").toBe(1);

    await bridge.stop();
  });
});
