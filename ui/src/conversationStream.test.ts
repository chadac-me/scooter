/**
 * The conversation-list stream's frame contract. A dropped or misread frame leaves the
 * sidebar disagreeing with the server until the backstop poll happens to run, so every
 * frame kind — and every malformed one — is pinned here.
 */
import { describe, it, expect, vi } from "vitest";

import { subscribeConversations } from "./conversationStream.js";
import type { ConversationView } from "./client.js";

const conv = (id: string, title = "T"): ConversationView =>
  ({ id, title }) as unknown as ConversationView;

/** A fetch stub serving one scripted SSE body, then holding the stream open. */
function sseFetch(frames: unknown[]): typeof fetch {
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const f of frames) {
          // Heartbeat comments and multi-line framing are part of the wire format.
          c.enqueue(enc.encode(typeof f === "string" ? f : `data: ${JSON.stringify(f)}\n\n`));
        }
        c.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

/** Run the subscription over a scripted body and collect what the callbacks saw. */
async function collect(frames: unknown[]) {
  const seen = { snapshots: [] as ConversationView[][], upserts: [] as ConversationView[], removes: [] as string[] };
  const sub = subscribeConversations(
    { baseUrl: "https://host" },
    "all",
    {
      onSnapshot: (l) => void seen.snapshots.push(l),
      onUpsert: (c) => void seen.upserts.push(c),
      onRemove: (id) => void seen.removes.push(id),
    },
    { fetchImpl: sseFetch(frames) },
  );
  // Let the reader drain the scripted body before asserting.
  await new Promise((r) => setTimeout(r, 0));
  sub.close();
  return seen;
}

describe("subscribeConversations frames", () => {
  it("applies a snapshot then upserts, in order", async () => {
    const seen = await collect([
      { kind: "snapshot", conversations: [conv("a"), conv("b")] },
      { kind: "upsert", conversation: conv("c") },
    ]);
    expect(seen.snapshots).toHaveLength(1);
    expect(seen.snapshots[0].map((c) => c.id)).toEqual(["a", "b"]);
    expect(seen.upserts.map((c) => c.id)).toEqual(["c"]);
  });

  it("applies a remove frame, which carries only an id", async () => {
    const seen = await collect([{ kind: "remove", id: "gone-1" }]);
    expect(seen.removes).toEqual(["gone-1"]);
    expect(seen.upserts).toEqual([]);
  });

  it("ignores a remove naming no conversation rather than removing something arbitrary", async () => {
    const seen = await collect([{ kind: "remove" }, { kind: "remove", id: "" }]);
    expect(seen.removes).toEqual([]);
  });

  it("ignores an unknown frame kind, so a newer server cannot break an older tab", async () => {
    const seen = await collect([{ kind: "reshuffle", whatever: 1 }, { kind: "remove", id: "x" }]);
    expect(seen.removes).toEqual(["x"]);
  });

  it("skips an unparseable frame and keeps reading the ones after it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen = await collect(["data: {not json\n\n", { kind: "remove", id: "after" }]);
    expect(seen.removes).toEqual(["after"]);
    warn.mockRestore();
  });

  it("ignores heartbeat comments", async () => {
    const seen = await collect([": keep-alive\n\n", { kind: "remove", id: "x" }]);
    expect(seen.removes).toEqual(["x"]);
  });

  it("handles a frame split across two chunks", async () => {
    // The body arrives in network-sized chunks, not frame-sized ones.
    const seen = await collect([`data: {"kind":"remove",`, `"id":"split"}\n\n`]);
    expect(seen.removes).toEqual(["split"]);
  });

  it("subscribes with the requested scope", async () => {
    const fetchImpl = vi.fn(sseFetch([]));
    const sub = subscribeConversations(
      { baseUrl: "https://host/" },
      "mine",
      { onSnapshot: () => {}, onUpsert: () => {}, onRemove: () => {} },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await new Promise((r) => setTimeout(r, 0));
    sub.close();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://host/conversations/events?scope=mine");
  });
});
