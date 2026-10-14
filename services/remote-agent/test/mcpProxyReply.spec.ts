// A tunnel reply must complete the proxied request.
import { describe, it, expect } from "vitest";
import { startMcpProxies } from "../src/mcpProxy.js";
import type { WireFrame } from "../src/protocol.js";

describe("mcpProxy reply path", () => {
  it("a tunnel chunk+close completes the local HTTP request", async () => {
    const sent: WireFrame[] = [];
    const cbs = new Set<(f: WireFrame) => void>();

    const mcp = await startMcpProxies([{ name: "scooter-env" }], {
      send: (f) => sent.push(f),
      onFrame: (cb) => {
        cbs.add(cb);
        return () => cbs.delete(cb);
      },
      sessionId: undefined,
    } as never);

    const url = mcp.servers[0].url;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const pending = fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    // Take the stream id the proxy chose.
    await new Promise<void>((r) => setTimeout(r, 120));
    const open = sent.find((f) => f.type === "open");
    expect(open, `no open frame was emitted: ${JSON.stringify(sent)}`).toBeTruthy();
    const id = open!.id!;

    // Reply as the cloud does.
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "t" }] } });
    for (const cb of cbs) {
      cb({ ch: "tunnel", type: "chunk", id, payload: { data: Buffer.from(payload).toString("base64") } } as WireFrame);
      cb({ ch: "tunnel", type: "close", id, payload: {} } as WireFrame);
    }

    const res = await Promise.race([
      pending,
      new Promise<Response>((_r, rej) => setTimeout(() => rej(new Error("HUNG: no reply")), 4000)),
    ]);
    expect(res.ok).toBe(true);
    expect(await res.text()).toContain('"tools"');
    await mcp.close();
  });
});
