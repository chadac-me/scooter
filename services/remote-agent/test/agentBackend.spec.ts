// Backend selection, and that `echo` needs no credential.
import { describe, it, expect } from "vitest";
import { selectBackend, BACKENDS } from "../src/agentBackend.js";
import "../src/echoBackend.js";

describe("agent backends", () => {
  it("defaults to claude, which requires auth", () => {
    const b = selectBackend();
    expect(b.id).toBe("claude");
    expect(b.needsClaudeAuth).toBe(true);
  });

  it("echo requires NO claude auth, so a container can attach without a token", () => {
    expect(selectBackend("echo").needsClaudeAuth).toBe(false);
  });

  it("an unknown backend fails loudly, naming what exists", () => {
    expect(() => selectBackend("nope")).toThrow(/unknown agent backend "nope"/);
    expect(Object.keys(BACKENDS)).toContain("echo");
  });

  it("echo answers ~tools PER TARGET from the offer", async () => {
    // Two targets, one reachable and one not: the reachable one must not mask it.
    const srv = await import("node:http").then((h) =>
      h.createServer((_q, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "echo_ping" }] } }));
      }),
    );
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;

    const client = await selectBackend("echo").create({
      exec: undefined,
      mcpServers: [
        { name: "scooter-env", url: `http://127.0.0.1:${port}/mcp` },
        { name: "scooter-broker", url: "http://127.0.0.1:1/mcp" }, // refused
      ],
    });
    const said: string[] = [];
    client.onSessionUpdate((_s, u) => {
      const t = (u as { content?: { text?: string } }).content?.text;
      if (t) said.push(t);
    });
    const { sessionId } = await client.newSession({} as never);
    await client.prompt({ sessionId, prompt: [{ text: "~tools" }] } as never);
    await client.close();
    srv.close();

    const reply = said.join("");
    expect(reply).toContain("scooter-env=echo_ping");
    // The unreachable target is REPORTED, not hidden by the healthy one.
    expect(reply).toMatch(/scooter-broker=\((tools\/list|.*threw)/);
  });
});
