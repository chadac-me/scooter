/**
 * Tier 3: the tool policy against real Claude, via the real SDK and a real `claude`
 * CLI subprocess. It proves that a denied tool's redirect reaches the model and that
 * deny-by-default leaves allowed tools working; it does not construct scooter-env
 * tools over the BYOC tunnel. Gated on RUN_REAL_CLAUDE=1 and authenticated with
 * CLAUDE_CODE_OAUTH_TOKEN or an existing `claude` login.
 */
import { describe, it, expect } from "vitest";

import type { ExecBackend, ExecRequest, TerminalHandle } from "./types.js";

const run = process.env.RUN_REAL_CLAUDE === "1";
const TIMEOUT = 180_000;

/** A local ExecBackend running the sandbox tools as subprocesses, so the test needs no cluster. */
function localExec(): ExecBackend {
  return {
    async run(): Promise<never> {
      throw new Error("not used");
    },
    spawn(req: ExecRequest): TerminalHandle {
      const cbs = new Set<(c: string) => void>();
      let done!: (v: { exitCode: number }) => void;
      const exit = new Promise<{ exitCode: number }>((r) => (done = r));
      void (async () => {
        const { spawn } = await import("node:child_process");
        const p = spawn(req.command, req.args ?? [], { cwd: "/tmp", env: process.env });
        p.stdout?.on("data", (d) => cbs.forEach((cb) => cb(String(d))));
        p.stderr?.on("data", (d) => cbs.forEach((cb) => cb(String(d))));
        p.on("close", (code) => done({ exitCode: code ?? 0 }));
      })();
      return {
        id: `local-${Math.random().toString(36).slice(2)}`,
        onOutput(cb) {
          cbs.add(cb);
        },
        waitForExit: () => exit,
        async kill() {},
        async release() {},
      };
    },
    async readTextFile() {
      return "";
    },
    async writeTextFile() {},
  };
}

/** A throwaway CLAUDE_CONFIG_DIR carrying only credentials, so no pre-approved tools alter the permission flow. */
function cleanConfigDir(): string {
  const { mkdtempSync, copyFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir, homedir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "scooter-claude-"));
  const creds = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(creds)) copyFileSync(creds, join(dir, ".credentials.json"));
  return dir;
}

/** Drive one real turn and collect what happened. */
async function realTurn(prompt: string) {
  const { createSdkAcpClient } = await import("./sdkClient.js");
  /** The tool names the CLI reports exposing to the model, from its init message. */
  const initTools: string[] = [];
  const client = await createSdkAcpClient({
    // Isolate from this machine's `claude` config, whose pre-approved tools the in-cluster agent-host does not have.
    extraEnv: { CLAUDE_CONFIG_DIR: cleanConfigDir() },
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
    model: process.env.REAL_CLAUDE_MODEL ?? "claude-sonnet-4-5",
    exec: localExec(),
    systemPrompt: "You are a test agent. Do exactly what is asked, briefly.",
    recordRaw: (msg) => {
      const m = msg as { type?: string; subtype?: string; tools?: unknown };
      if (m.type === "system" && m.subtype === "init" && Array.isArray(m.tools)) initTools.push(...(m.tools as string[]));
    },
  });

  const text: string[] = [];
  const toolCalls: string[] = [];
  client.onSessionUpdate((_sid, u) => {
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") text.push(u.content.text);
    if (u.sessionUpdate === "tool_call") toolCalls.push(u.title);
  });

  await client.initialize({ protocolVersion: 1 } as never);
  const { sessionId } = await client.newSession({ cwd: "/tmp", mcpServers: [] } as never);

  let threw: Error | undefined;
  let stopReason = "";
  try {
    ({ stopReason } = await client.prompt({ sessionId, prompt: [{ type: "text", text: prompt }] } as never));
  } catch (e) {
    threw = e as Error;
  }
  await client.close().catch(() => {});
  return { text: text.join(""), toolCalls, threw, stopReason, initTools };
}

describe.skipIf(!run)("real Claude — tool policy", () => {
  it(
    "a DENIED tool completes the turn (NB: passes pre-fix too — see the file header)",
    async () => {
      // WebSearch is denied, not wired.
      const { text, threw } = await realTurn(
        "Use your WebSearch tool to search for 'kubernetes operator pattern'. " +
          "If you cannot, say what you would use instead.",
      );

      // The turn must complete, whatever the model said.
      expect(threw, `the turn threw: ${threw?.message}`).toBeUndefined();
      expect(text.length, "the model must have replied").toBeGreaterThan(0);
      // And it must not be the headless-prompt stall.
      expect(threw?.message ?? "").not.toMatch(/stop_reason=tool_use|ede_diagnostic/);
    },
    TIMEOUT,
  );

  it(
    "the model SEES the deny reason and reports it, rather than stalling",
    async () => {
      // The deny reason must reach the model; this harness runs without mcpEndpointUrl, so it cannot be expected to name `web_search`.
      const { text, threw } = await realTurn(
        "Search the web for the current Kubernetes release. If a tool is unavailable, " +
          "say so explicitly and explain what happened.",
      );
      expect(threw).toBeUndefined();
      expect(text).toMatch(/not available|unavailable|cannot|can't/i);
      expect(text).toMatch(/websearch/i); // it identifies which tool was refused
    },
    TIMEOUT,
  );

  it(
    "an ALLOWED sandbox tool still runs end to end",
    async () => {
      // Deny-by-default must not break what should work.
      const { text, toolCalls, threw } = await realTurn(
        "Run the shell command `echo scooter-policy-ok` and tell me its output.",
      );
      expect(threw).toBeUndefined();
      expect(`${text} ${toolCalls.join(" ")}`).toMatch(/scooter-policy-ok/);
    },
    TIMEOUT,
  );
});

describe.skipIf(!run)("real Claude — the CLI's built-ins match the policy", () => {
  it(
    "every built-in the CLI exposes is one the policy names, and no native subagent tool is visible @proves",
    async () => {
      // A CLI release that renames or adds a built-in (Task became Agent) must fail here, not silently in production.
      const { ALLOWED_BUILTINS, SUBAGENT_BUILTINS, TOOL_REDIRECTS } = await import("./toolPolicy.js");
      const { initTools, threw } = await realTurn("Reply with the single word: ok");
      expect(threw).toBeUndefined();
      expect(initTools.length, "the CLI must report its tools in the init message").toBeGreaterThan(0);

      const builtins = initTools.filter((t) => !t.startsWith("mcp__"));
      const known = new Set<string>([...ALLOWED_BUILTINS, ...Object.keys(TOOL_REDIRECTS)]);
      expect(builtins.filter((t) => !known.has(t)), "built-ins the policy does not name").toEqual([]);
      expect(builtins.filter((t) => (SUBAGENT_BUILTINS as readonly string[]).includes(t))).toEqual([]);
    },
    TIMEOUT,
  );
});
