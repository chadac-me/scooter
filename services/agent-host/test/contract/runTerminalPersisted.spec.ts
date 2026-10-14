/**
 * A prompt that returns normally must persist a terminal event: the UI derives "is this
 * run active?" from the log alone, so a log with no terminal event shows "Working"
 * forever. Asserted on the persist channel, since the UI is repainted from the log
 * after a reload.
 */
import { describe, it, expect } from "vitest";

import { createSessionBridge } from "../../src/bridge.js";
import type { AguiEvent } from "../../src/bridge.js";
import { createFakeAcpAgent } from "../fakes/fakeAcpAgent.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import { acpClientFromTransport } from "../fakes/acpClientFromTransport.js";

const BRIDGE_CONFIG = {
  cwd: "/tmp",
  agent: { command: "fake", args: [] as string[], env: {} as Record<string, string> },
  sandbox: { name: "s1", namespace: "ns" },
} as never;

/** A bridge wired to a fake ACP agent, recording everything it persists. */
function bridgeWithPersistLog() {
  const exec = createSandboxExecBackend(createFakeSandboxApi());
  const agent = createFakeAcpAgent();
  // A minimal complete turn: one message chunk, then a normal end_turn.
  agent.setScript([
    { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
    { finish: { stopReason: "end_turn" } },
  ]);
  const bridge = createSessionBridge({
    config: BRIDGE_CONFIG,
    exec,
    acpClient: acpClientFromTransport(agent.transport, exec) as never,
  } as never);
  const persisted: AguiEvent[] = [];
  bridge.onPersist((e) => persisted.push(e));
  return { bridge, persisted };
}

const TERMINALS = ["RUN_FINISHED", "RUN_ERROR"];

describe("a completed run persists a terminal event", () => {
  it("a normal turn ends with RUN_FINISHED in the LOG", async () => {
    const { bridge, persisted } = bridgeWithPersistLog();

    await bridge.prompt({ threadId: "t1", text: "hello", source: "ui" } as never);

    const types = persisted.map((e) => e.type);
    expect(types, "the run must have started").toContain("RUN_STARTED");
    expect(
      types.filter((t) => TERMINALS.includes(t)),
      `no terminal event was persisted; the log ends mid-run: ${types.join(", ")}`,
    ).not.toHaveLength(0);
  });

  it("every RUN_STARTED is matched by a terminal event, across several turns", async () => {
    // Multi-turn catches the case where only the first or last run terminates.
    const { bridge, persisted } = bridgeWithPersistLog();

    await bridge.prompt({ threadId: "t1", text: "one", source: "ui" } as never);
    await bridge.prompt({ threadId: "t1", text: "two", source: "ui" } as never);

    const types = persisted.map((e) => e.type);
    const starts = types.filter((t) => t === "RUN_STARTED").length;
    const ends = types.filter((t) => TERMINALS.includes(t)).length;
    expect(starts, "both turns ran").toBe(2);
    expect(ends, `each run must terminate; got ${starts} starts and ${ends} terminals`).toBe(starts);
  });
});
