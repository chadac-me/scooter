/**
 * view_image: an agent must be able to SEE an image in its own sandbox. The fake client
 * runs the real in-pod script on this host, so stat/base64 and the argv quoting are
 * exercised, and one case goes through a real McpServer to prove the image block
 * survives the MCP SDK.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { handleViewImage, imageMimeType, IMAGE_MAX_BYTES, type ImageToolsWiring } from "../../src/agent/imageTools.js";
import { buildServer } from "../../src/agent/mcpServer.js";
import type { SandboxApiClient } from "../../src/exec/sandboxExec.js";
import type { ExecRequest } from "../../src/types.js";

// A 1x1 transparent PNG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A SandboxApiClient whose execute() runs the request on this host (cwd ignored: /workspace need not exist here). */
function hostClient(): { client: SandboxApiClient; reqs: ExecRequest[] } {
  const reqs: ExecRequest[] = [];
  const client: SandboxApiClient = {
    mode: "direct",
    async execute(req) {
      reqs.push(req);
      const r = spawnSync(req.command, req.args, { encoding: "utf8" });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
    async download() { throw new Error("view_image must not use the text download path"); },
    async upload() { throw new Error("not used"); },
    async uploadBinary() { throw new Error("not used"); },
  };
  return { client, reqs };
}

function wiringFor(client: SandboxApiClient): { wiring: ImageToolsWiring; asked: string[] } {
  const asked: string[] = [];
  return { wiring: { client: (id) => { asked.push(id); return client; } }, asked };
}

function tmpImage(name: string, bytes: Buffer): string {
  const path = join(mkdtempSync(join(tmpdir(), "scooter-view-image-")), name);
  writeFileSync(path, bytes);
  return path;
}

describe("view_image handler", () => {
  it("returns the sandbox file as an image block, resolved for THIS conversation", async () => {
    // A quote, a space and `$(...)` in the name: the path must reach stat/base64 as one literal argument.
    const path = tmpImage("it's a $(id) shot.PNG", Buffer.from(PNG_B64, "base64"));
    const { client, reqs } = hostClient();
    const { wiring, asked } = wiringFor(client);
    const res = await handleViewImage(wiring, "conv-7", { path });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual([{ type: "image", data: PNG_B64, mimeType: "image/png" }]);
    expect(asked).toEqual(["conv-7"]);
    expect(reqs).toHaveLength(1);
  });

  it("refuses an image over the API limit without shipping it", async () => {
    const path = tmpImage("huge.jpg", Buffer.alloc(IMAGE_MAX_BYTES + 1));
    const { client } = hostClient();
    const res = await handleViewImage(wiringFor(client).wiring, "c", { path });
    expect(res.isError).toBe(true);
    expect(res.content).toHaveLength(1);
    expect((res.content[0] as { text: string }).text).toMatch(/Downscale/);
  });

  it("errors cleanly on a missing file", async () => {
    const { client } = hostClient();
    const res = await handleViewImage(wiringFor(client).wiring, "c", { path: "/nonexistent/shot.png" });
    expect(res.isError).toBe(true);
  });

  it("rejects a non-image path and an empty path without touching the sandbox", async () => {
    const { client, reqs } = hostClient();
    const { wiring } = wiringFor(client);
    expect((await handleViewImage(wiring, "c", { path: "/workspace/notes.md" })).isError).toBe(true);
    expect((await handleViewImage(wiring, "c", { path: "  " })).isError).toBe(true);
    expect(reqs).toHaveLength(0);
  });

  it("resolves a relative path under /workspace", async () => {
    const reqs: ExecRequest[] = [];
    const client: SandboxApiClient = {
      ...hostClient().client,
      async execute(req) { reqs.push(req); return { exitCode: 0, stdout: PNG_B64, stderr: "" }; },
    };
    await handleViewImage(wiringFor(client).wiring, "c", { path: "shots/a.png" });
    expect(reqs[0].args.at(-1)).toBe("/workspace/shots/a.png");
  });

  it("reports a sandbox that cannot be reached as a tool error, not a throw", async () => {
    const wiring: ImageToolsWiring = { client: () => { throw new Error("no such conversation"); } };
    const res = await handleViewImage(wiring, "gone", { path: "/workspace/a.png" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("no such conversation");
  });

  it("maps the supported extensions to mime types", () => {
    expect(imageMimeType("/a/b.png")).toBe("image/png");
    expect(imageMimeType("/a/b.JPEG")).toBe("image/jpeg");
    expect(imageMimeType("/a/b.gif")).toBe("image/gif");
    expect(imageMimeType("/a/b.webp")).toBe("image/webp");
    expect(imageMimeType("/a/b.svg")).toBeUndefined();
    expect(imageMimeType("/a/png")).toBeUndefined();
  });
});

describe("view_image over MCP", () => {
  it("is registered only when wired, and returns image content to an MCP client", async () => {
    const { client: sandbox } = hostClient();
    const path = tmpImage("shot.png", Buffer.from(PNG_B64, "base64"));

    const connect = async (images?: ImageToolsWiring) => {
      const server = await buildServer("conv-1", undefined, undefined, undefined, undefined, undefined, undefined, undefined, images);
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "t", version: "0" });
      await client.connect(clientT);
      return client;
    };

    const unwired = await connect();
    expect((await unwired.listTools()).tools.map((t) => t.name)).not.toContain("view_image");

    const client = await connect(wiringFor(sandbox).wiring);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("view_image");
    const res = await client.callTool({ name: "view_image", arguments: { path } });
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([{ type: "image", data: PNG_B64, mimeType: "image/png" }]);
  });
});
