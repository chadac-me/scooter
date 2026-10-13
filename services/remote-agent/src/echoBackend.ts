/** A backend with no model and no credential, so the real tunnel is testable. */
import { registerBackend, type AgentBackend, type AgentBackendDeps } from "./agentBackend.js";

type Update = { sessionUpdate: string; content?: { type: string; text: string } };

/** Tool names at one MCP endpoint, or why it could not be reached. */
async function listToolsAt(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const body = await res.text();
    if (!res.ok) return `(tools/list ${res.status}: ${body.slice(0, 120)})`;
    // The endpoint may answer SSE; take the last data: frame.
    const frame = body.includes("data:")
      ? (body.split("\n").filter((l) => l.startsWith("data:")).pop() ?? "").slice(5).trim()
      : body;
    const tools = (JSON.parse(frame || "{}") as { result?: { tools?: Array<{ name?: string }> } }).result?.tools ?? [];
    return tools.map((t) => t.name ?? "?").join(",") || "(none)";
  } catch (err) {
    return `(tools/list threw: ${err instanceof Error ? err.message : String(err)})`;
  }
}

const echoBackend: AgentBackend = {
  id: "echo",
  needsClaudeAuth: false,
  async create(deps: AgentBackendDeps) {
    const updateCbs = new Set<(sessionId: string, u: Update) => void>();
    const offered = deps.mcpServers ?? [];
    let alive = true;
    let n = 0;

    const say = (sessionId: string, text: string) => {
      for (const cb of updateCbs) {
        cb(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      }
    };

    return {
      async initialize() {
        return { protocolVersion: 1 };
      },
      async newSession() {
        return { sessionId: `echo-${++n}` };
      },
      async prompt(params: { sessionId: string; prompt?: Array<{ text?: string }> }) {
        const text = (params.prompt ?? []).map((b) => b.text ?? "").join(" ").trim();
        if (text.startsWith("~tools")) {
          // Per target: a reachable one must not mask an unreachable one.
          const parts = await Promise.all(
            offered.map(async (s) => `${s.name}=${await listToolsAt(s.url)}`),
          );
          say(params.sessionId, `tools ${parts.length ? parts.join(" | ") : "(no MCP endpoint offered)"}`);
        } else if (text.startsWith("~model")) {
          say(params.sessionId, `model=${deps.model ?? "(none)"}`);
        } else {
          say(params.sessionId, `echo: ${text}`);
        }
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      async killActiveTerminals() {},
      isAlive: () => alive,
      onSessionUpdate(cb: (sessionId: string, u: Update) => void) {
        updateCbs.add(cb);
        return () => updateCbs.delete(cb);
      },
      onTerminalCreated() {
        return () => {};
      },
      onPermissionRequest() {},
      async close() {
        alive = false;
      },
    } as never;
  },
};

registerBackend(echoBackend);
export { echoBackend };
