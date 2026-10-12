/**
 * Standalone fake ACP agent (stdio binary), a `goose acp` stand-in that speaks the
 * real ACP wire protocol via the SDK's AgentSideConnection, so the agent-host spawns
 * it exactly like goose. It needs no model provider: it echoes the user's prompt and
 * streams a deterministic turn (reasoning, tool call, result, reply). The agent-host
 * runs `node dist/fakeAgent.js` when GOOSE_BIN=fake.
 */

import { Readable, Writable } from "node:stream";

import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
  type AuthenticateRequest,
} from "@zed-industries/agent-client-protocol";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long a `~subagent` child stays running, which must outlast the spec asserting on it since the host end()s a subagent as soon as it completes. */
const SUBAGENT_LIFETIME_S = 90;

/** Wrap `s` so `sh -c` sees it as one literal argument, whatever it contains. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

class FakeAgent implements Agent {
  constructor(private conn: AgentSideConnection) {}

  /** Sessions that have already received their first prompt, so the <title> marker is emitted only on the first reply. */
  private titled = new Set<string>();
  // Each tool call gets a fresh id, as real ACP agents mint one per call.
  private toolCallSeq = 0;
  /** The scooter-env MCP endpoint newSession offers per session, with the headers carrying the bearer conversation token it needs. */
  private mcpUrl = new Map<string, string>();
  private mcpHeaders = new Map<string, Record<string, string>>();

  async initialize(_p: InitializeRequest): Promise<InitializeResponse> {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }

  async newSession(p: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = `fake-${Math.random().toString(36).slice(2, 10)}`;
    const offered =
      (
        p as {
          mcpServers?: Array<{ name?: string; url?: string; headers?: Array<{ name: string; value: string }> }>;
        }
      ).mcpServers ?? [];
    const env = offered.find((s) => s.name === "scooter-env" && typeof s.url === "string");
    if (env?.url) {
      this.mcpUrl.set(sessionId, env.url);
      // `headers` is HttpHeader[] ({name,value}) per the ACP schema.
      this.mcpHeaders.set(
        sessionId,
        Object.fromEntries((env.headers ?? []).map((h) => [h.name, h.value])),
      );
    }
    return { sessionId };
  }

  /** Call one scooter-env MCP tool with a standalone tools/call (the endpoint is stateless); the reply may be an SSE frame. */
  private async callTool(sessionId: string, name: string, args: unknown): Promise<string> {
    const url = this.mcpUrl.get(sessionId);
    if (!url) return "no scooter-env MCP endpoint was offered to this session";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.mcpHeaders.get(sessionId) ?? {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = await res.text();
    if (!res.ok) return `MCP ${name} failed: ${res.status} ${body.slice(0, 200)}`;
    const frame = body.includes("data:")
      ? (body.split("\n").filter((l) => l.startsWith("data:")).pop() ?? "").slice(5).trim()
      : body;
    try {
      const parsed = JSON.parse(frame) as {
        result?: { content?: Array<{ text?: string }> };
        error?: { message?: string };
      };
      if (parsed.error) return `MCP ${name} error: ${parsed.error.message ?? "unknown"}`;
      return (parsed.result?.content ?? []).map((c) => c.text ?? "").join("\n").trim();
    } catch {
      return `MCP ${name} returned unparseable body: ${frame.slice(0, 200)}`;
    }
  }

  async authenticate(_p: AuthenticateRequest): Promise<void> {
    return;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const sessionId = params.sessionId;
    // The user's actual message is the last text block; a revived session prepends a
    // history preamble as an earlier block.
    const textBlocks = params.prompt.filter((b) => b.type === "text").map((b) => b.text);
    const userText = (textBlocks.at(-1) ?? "").trim() || "(no text)";

    const u = (update: Parameters<AgentSideConnection["sessionUpdate"]>[0]["update"]) =>
      this.conn.sessionUpdate({ sessionId, update });

    // A "?<prompt>" message is a test directive: present an option choice via the ACP
    // permission round-trip and report the picked option.
    if (userText.startsWith("?")) {
      const question = userText.slice(1).trim() || "Choose an option";
      const res = (await this.conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: "choose_1", title: question } as never,
        options: [
          { optionId: "red", name: "Red", kind: "allow_once" },
          { optionId: "green", name: "Green", kind: "allow_once" },
          { optionId: "blue", name: "Blue", kind: "allow_once" },
        ],
      } as never)) as { outcome: { outcome: string; optionId?: string } };
      const picked =
        res.outcome.outcome === "selected" ? res.outcome.optionId : "(cancelled)";
      const reply = `🤖 (dummy agent) you picked: ${picked}`;
      for (const word of reply.split(" ")) {
        await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: word + " " } });
        await sleep(20);
      }
      return { stopReason: "end_turn" };
    }

    // A "~model" message is a test directive: report the GOOSE_MODEL this process was launched with.
    if (userText.startsWith("~model")) {
      const reply = `model=${process.env.GOOSE_MODEL ?? "(default)"}`;
      for (const word of reply.split(" ")) {
        await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: word + " " } });
        await sleep(10);
      }
      return { stopReason: "end_turn" };
    }

    // A "~images" message is a test directive: report how many image content blocks reached this prompt.
    if (userText.startsWith("~images")) {
      const count = params.prompt.filter((b) => b.type === "image").length;
      const reply = `images=${count}`;
      for (const word of reply.split(" ")) {
        await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: word + " " } });
        await sleep(10);
      }
      return { stopReason: "end_turn" };
    }

    // A "~subagent <title>" message is a test directive: spawn a real subagent via the
    // scooter-env MCP tool, whose child sleeps because the host end()s it as soon as its run completes.
    if (userText.startsWith("~subagent")) {
      const title = userText.slice("~subagent".length).trim() || "research task";
      await u({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Delegating…" } });
      const out = await this.callTool(sessionId, "spawn_subagent", {
        prompt: `!sleep ${SUBAGENT_LIFETIME_S}`,
        title,
      });
      const reply = `🤖 (dummy agent) spawned a subagent: ${out}`;
      for (const word of reply.split(" ")) {
        await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: word + " " } });
        await sleep(10);
      }
      return { stopReason: "end_turn" };
    }

    // A "!<command>" message is a test directive: run <command> verbatim in the sandbox
    // and report its output; anything else gets an echo.
    const isCommand = userText.startsWith("!");
    // Quote the echoed prose so shell metacharacters reach echo as one literal argument;
    // the "!<command>" directive is deliberately unquoted.
    const command = isCommand ? userText.slice(1).trim() : `echo ${shellQuote(userText)}`;

    // 1. a thought
    await u({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Planning a response…" } });
    await sleep(300);

    // 2. a real tool call through createTerminal, the bridge ACP client and the ExecBackend
    let cmdOutput = "";
    let exitCode = 0;
    const toolCallId = `call_${++this.toolCallSeq}`;
    // Match real goose's shell shape: the tool_call carries no rawInput, the command runs
    // via terminal/create, and the terminal is handed off as the tool_call_update content.
    await u({
      sessionUpdate: "tool_call",
      toolCallId,
      title: `run: ${command}`,
      kind: "execute",
      status: "pending",
    } as never);
    let terminalId = "";
    try {
      const term = await this.conn.createTerminal({
        sessionId,
        command: "sh",
        args: ["-c", command],
      });
      terminalId = term.id;
      // Hand off the live terminal, with no rawInput.
      await u({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [{ type: "terminal", terminalId }],
      } as never);
      const exit = await term.waitForExit();
      exitCode = exit.exitCode ?? 0;
      const out = await term.currentOutput();
      cmdOutput = out.output ?? "";
      await term.release();
    } catch (e) {
      cmdOutput = `exec error: ${String(e)}`;
      exitCode = 1;
    }
    // The real finish, carrying the command's output as content.
    await u({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: exitCode === 0 ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: cmdOutput } }],
    } as never);
    await sleep(200);

    // The first reply in a session emits a <title> marker derived from the user's request.
    if (!this.titled.has(sessionId)) {
      this.titled.add(sessionId);
      const titleText = (isCommand ? command : userText).slice(0, 40).trim();
      await u({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `<title>${titleText}</title>` },
      });
      await sleep(40);
    }

    // 3. the reply (streamed), reporting the command output (proves exec ran)
    const reply = isCommand
      ? `🤖 (dummy agent) ran \`${command}\` (exit ${exitCode}):\n${cmdOutput.trim() || "(no output)"}`
      : `🤖 (dummy agent) ran echo: "${cmdOutput.trim()}". (fake mode — real exec chain exercised, no model needed.)`;
    for (const word of reply.split(" ")) {
      await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: word + " " } });
      await sleep(40);
    }

    return { stopReason: "end_turn" };
  }

  async cancel(_p: CancelNotification): Promise<void> {
    return;
  }
}

const input = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
new AgentSideConnection((conn) => new FakeAgent(conn), ndJsonStream(input, output));
