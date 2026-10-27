/**
 * The real `claude` CLI against the real scooter-env MCP endpoint, bound on
 * localhost with only `jobs` wired. It proves the MCP tools are reachable and
 * answerable end to end; an exposed but unanswerable tool stalls the turn on a
 * permission nobody can resolve. The model test is gated on RUN_REAL_CLAUDE=1 and
 * authenticates via CLAUDE_CODE_OAUTH_TOKEN or an existing `claude` login.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, afterAll } from "vitest";

import { createMcpEndpoint } from "../../src/agent/mcpServer.js";
import type { JobManager, JobStatus, JobRecord } from "../../src/session/jobManager.js";

const run = process.env.RUN_REAL_CLAUDE === "1";
const TIMEOUT = 180_000;

/** A JobManager backed by real child processes, so the endpoint dispatches against something that runs and finishes. */
function localJobs(): JobManager {
  const jobs = new Map<string, JobStatus>();
  let seq = 0;
  return {
    async start(_id, command) {
      const jobId = `job-local-${++seq}`;
      const { exec } = await import("node:child_process");
      jobs.set(jobId, { jobId, command, state: "running", output: "", truncated: false, logPath: "/dev/null" });
      exec(command, { cwd: tmpdir() }, (err, stdout, stderr) => {
        jobs.set(jobId, {
          jobId,
          command,
          state: "exited",
          exitCode: err ? ((err as { code?: number }).code ?? 1) : 0,
          output: `${stdout}${stderr}`,
          truncated: false,
          logPath: "/dev/null",
        });
      });
      return { jobId };
    },
    async check(_id, jobId) {
      return (
        jobs.get(jobId) ?? { jobId, command: "", state: "unknown", output: "", truncated: false, logPath: "/dev/null" }
      );
    },
    async list() {
      return [...jobs.values()].map((j) => ({ jobId: j.jobId, command: j.command, startedAt: 1 }) as JobRecord);
    },
    async kill(_id, jobId) {
      return { jobId, outcome: "unknown" as const };
    },
    async cleanup() {},
    async markNotified() {},
    async pollCompletions() {
      return [];
    },
    async hasRunning() {
      return false;
    },
  } as unknown as JobManager;
}

const HARNESS_SECRET = "realclaude-harness-conv-secret";

/** Bind the real MCP endpoint on a loopback port and return its per-conversation URL. */
async function serveMcp(deps: Partial<Parameters<typeof createMcpEndpoint>[0]> = {}): Promise<{
  url: string;
  authHeaders: Record<string, string>;
  close: () => Promise<void>;
}> {
  // Listen first so the endpoint is built once, with the real port in its baseUrl.
  let handle: (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: unknown;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      } catch {
        body = undefined;
      }
      void handle(req, res, body).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const endpoint = createMcpEndpoint({
    baseUrl: `http://127.0.0.1:${port}`,
    jobs: localJobs(),
    // The endpoint takes its conversation from a signed token, so the harness mints one like the real caller.
    convTokenSecret: HARNESS_SECRET,
    ...deps,
  });
  handle = endpoint.handle;
  return {
    url: endpoint.urlFor("conv-test"),
    authHeaders: Object.fromEntries(
      endpoint.headersFor("conv-test").map((h) => [h.name, h.value]),
    ),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A throwaway CLAUDE_CONFIG_DIR carrying only credentials, so the permission flow behaves as it does in-cluster. */
function cleanConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scooter-mcp-claude-"));
  const creds = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(creds)) copyFileSync(creds, join(dir, ".credentials.json"));
  return dir;
}

const servers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of servers) await close();
});

// Ungated and credential-free: proves the harness itself wires up.
describe("the scooter-env MCP endpoint answers over HTTP", () => {
  it("serves tools/list with the background-job tools", async () => {
    const mcp = await serveMcp();
    servers.push(mcp.close);
    const res = await fetch(mcp.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...mcp.authHeaders,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.ok).toBe(true);
    expect(await res.text()).toMatch(/run_background/);
  });
});

describe.skipIf(!run)("REAL claude + REAL scooter-env MCP endpoint", () => {
  it(
    "the model can call a scooter-env tool over HTTP and get an answer back",
    async () => {
      const mcp = await serveMcp();
      servers.push(mcp.close);
      const { createSdkAcpClient } = await import("@scooter/claude-sdk-provider");
      const client = await createSdkAcpClient({
        extraEnv: { CLAUDE_CONFIG_DIR: cleanConfigDir() },
        oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
        model: process.env.REAL_CLAUDE_MODEL ?? "claude-sonnet-4-5",
        exec: {
          async run() {
            throw new Error("not used");
          },
          spawn() {
            throw new Error("not used");
          },
          async readTextFile() {
            return "";
          },
          async writeTextFile() {},
          async writeBinaryFile() {},
        } as never,
        systemPrompt: "You are a test agent. Use the tools you are given. Be brief.",
        mcpEndpointUrl: mcp.url,
      } as never);

      const toolCalls: string[] = [];
      client.onSessionUpdate((_sid, u: { sessionUpdate: string; title?: string }) => {
        if (u.sessionUpdate === "tool_call" && u.title) toolCalls.push(u.title);
      });

      await client.initialize({ protocolVersion: 1 } as never);
      const { sessionId } = await client.newSession({ cwd: "/tmp", mcpServers: [] } as never);

      // A turn that cannot be answered from the model's own knowledge, so it has to reach the endpoint.
      const res = await client.prompt({
        sessionId,
        prompt: [
          {
            type: "text",
            text: "Use the run_background tool to run exactly: echo scooter-mcp-ok. Then report that you started it.",
          },
        ],
      } as never);

      expect(res).toBeDefined();
      expect(toolCalls.join(" ")).toMatch(/run_background/i);
    },
    TIMEOUT,
  );

});

describe("the harness itself is load-bearing", () => {
  it("an endpoint with NO jobs wiring does NOT advertise the job tools", async () => {
    // If this goes green with the tools present, the harness is testing a different endpoint than it serves.
    const mcp = await serveMcp({ jobs: undefined });
    servers.push(mcp.close);
    const res = await fetch(mcp.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...mcp.authHeaders,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(await res.text()).not.toMatch(/run_background/);
  });
});
