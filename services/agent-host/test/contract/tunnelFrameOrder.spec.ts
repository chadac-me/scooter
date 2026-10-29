/**
 * A response's frames must reach the container in order: a close that overtakes the
 * last chunk makes the container drop that chunk, truncating the MCP reply.
 */

import { describe, it, expect } from "vitest";

import { createOrderedSender } from "../../src/acp/tunnelClient.js";
import type { WireFrame } from "../../src/acp/remoteProtocol.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = (id: string, type: string, n = 0): WireFrame =>
  ({ ch: "tunnel", type, id, payload: { data: String(n) } }) as never;

/** A post whose latency depends on the frame: big chunks slow, close fast. */
const recordingPost = (latency: (f: WireFrame) => number) => {
  const arrived: string[] = [];
  const post = async (f: WireFrame) => {
    await sleep(latency(f));
    arrived.push(`${f.id}:${f.type}:${(f.payload as { data?: string }).data ?? ""}`);
  };
  return { post, arrived };
};

describe("tunnel replies keep each stream's frame order", () => {
  it("a fast close never overtakes a slow chunk @proves", async () => {
    const { post, arrived } = recordingPost((f) => (f.type === "chunk" ? 20 : 1));
    const send = createOrderedSender(post);
    send(frame("s1", "chunk", 1));
    send(frame("s1", "chunk", 2));
    send(frame("s1", "close"));
    await sleep(80);
    expect(arrived).toEqual(["s1:chunk:1", "s1:chunk:2", "s1:close:0"]);
  });

  it("chunks of one stream arrive in send order even when an earlier one is slower", async () => {
    const { post, arrived } = recordingPost((f) => ((f.payload as { data?: string }).data === "1" ? 30 : 1));
    const send = createOrderedSender(post);
    send(frame("s1", "chunk", 1));
    send(frame("s1", "chunk", 2));
    send(frame("s1", "chunk", 3));
    await sleep(80);
    expect(arrived).toEqual(["s1:chunk:1", "s1:chunk:2", "s1:chunk:3"]);
  });

  it("different streams are not serialized behind each other", async () => {
    const { post, arrived } = recordingPost((f) => (f.id === "slow" ? 40 : 1));
    const send = createOrderedSender(post);
    send(frame("slow", "chunk", 1));
    send(frame("fast", "chunk", 1));
    await sleep(15);
    expect(arrived).toEqual(["fast:chunk:1"]);
    await sleep(40);
    expect(arrived).toEqual(["fast:chunk:1", "slow:chunk:1"]);
  });

  it("a failed post does not stall the rest of its stream", async () => {
    const arrived: string[] = [];
    const send = createOrderedSender(async (f) => {
      if ((f.payload as { data?: string }).data === "1") throw new Error("boom");
      arrived.push(`${f.type}:${(f.payload as { data?: string }).data ?? ""}`);
    });
    send(frame("s1", "chunk", 1));
    send(frame("s1", "chunk", 2));
    send(frame("s1", "close"));
    await sleep(10);
    expect(arrived).toEqual(["chunk:2", "close:0"]);
  });
});
