/**
 * The ownership guard's row feed: a full load on (re)connect, per-id re-reads on
 * conversation_assignment notifications, deletes dropping the entry, and confirmOwns() reading
 * the row rather than trusting the cache. Driven through a fake AssignmentSource.
 */

import { describe, it, expect, vi } from "vitest";

import { createPgOwnershipGuard, type AssignmentRow, type AssignmentSource } from "../../src/session/pgOwnershipGuard.js";
import type { SessionId } from "../../src/types.js";

const sid = (s: string) => s as SessionId;
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeSource() {
  const rows = new Map<string, AssignmentRow>();
  let handlers: Parameters<AssignmentSource["subscribe"]>[0] | undefined;
  let fail: Error | undefined;
  const read = vi.fn(async (ids?: string[]) => {
    if (fail) {
      const e = fail;
      fail = undefined;
      throw e;
    }
    const all = [...rows.values()];
    return ids ? all.filter((r) => ids.includes(r.id)) : all.filter((r) => r.hostPod !== null);
  });
  const source: AssignmentSource = {
    read,
    subscribe: (h) => {
      handlers = h;
      return () => {
        handlers = undefined;
      };
    },
  };
  return {
    source,
    read,
    set: (id: string, hostPod: string | null, generation: number) => rows.set(id, { id, hostPod, generation }),
    del: (id: string) => rows.delete(id),
    connect: () => handlers!.onConnected(),
    notify: (id: string) => handlers!.onNotify(id),
    failNext: (e: Error) => {
      fail = e;
    },
  };
}

describe("pgOwnershipGuard — the guard follows the conversations row", () => {
  it("loads every assigned row once LISTEN is up", async () => {
    const src = fakeSource();
    src.set("mine", "host-a", 3);
    src.set("theirs", "host-b", 1);
    src.set("unassigned", null, 0);
    const { guard, stop } = createPgOwnershipGuard("host-a", src.source);
    src.connect();
    await flush();
    expect(guard.owns(sid("mine"))).toBe(true);
    expect(guard.observedGeneration(sid("mine"))).toBe(3);
    expect(guard.canWrite(sid("theirs"))).toBe(false);
    expect(guard.owns(sid("unassigned"))).toBe(false);
    expect(guard.canWrite(sid("unassigned"))).toBe(true); // fails open, as before assignment
    stop();
  });

  it("a notification re-reads the row: reassignment, epoch bump and DELETE all land", async () => {
    const src = fakeSource();
    src.set("c", "host-a", 1);
    const { guard, stop } = createPgOwnershipGuard("host-a", src.source);
    src.connect();
    await flush();

    src.set("c", "host-a", 2); // a revive in place bumps the epoch
    src.notify("c");
    await flush();
    expect(guard.observedGeneration(sid("c"))).toBe(2);

    src.set("c", "host-b", 3);
    src.notify("c");
    await flush();
    expect(guard.canWrite(sid("c"))).toBe(false);

    src.set("c", "host-a", 4);
    src.notify("c");
    await flush();
    src.del("c"); // deleted through another pod
    src.notify("c");
    await flush();
    expect(guard.owns(sid("c"))).toBe(false);
    stop();
  });

  it("notifications in one tick are read in ONE query", async () => {
    const src = fakeSource();
    const { stop } = createPgOwnershipGuard("host-a", src.source);
    src.connect();
    await flush();
    src.read.mockClear();
    src.notify("a");
    src.notify("b");
    src.notify("a");
    await flush();
    expect(src.read).toHaveBeenCalledTimes(1);
    expect(src.read.mock.calls[0][0]?.sort()).toEqual(["a", "b"]);
    stop();
  });

  it("onGained fires when the feed moves a conversation to this pod", async () => {
    const src = fakeSource();
    src.set("c", "host-b", 1);
    const { guard, stop } = createPgOwnershipGuard("host-a", src.source);
    const gained = vi.fn();
    guard.onGained = gained;
    src.connect();
    await flush();
    src.set("c", "host-a", 2);
    src.notify("c");
    await flush();
    expect(gained).toHaveBeenCalledWith("c", 2);
    stop();
  });

  it("a reconnect resyncs: rows deleted or moved while disconnected are dropped", async () => {
    const src = fakeSource();
    src.set("gone", "host-a", 1);
    src.set("moved", "host-a", 1);
    const { guard, stop } = createPgOwnershipGuard("host-a", src.source);
    src.connect();
    await flush();
    src.del("gone"); // no notification reaches us: the LISTEN was down
    src.set("moved", "host-b", 2);
    src.connect();
    await flush();
    expect(guard.owns(sid("gone"))).toBe(false);
    expect(guard.owns(sid("moved"))).toBe(false);
    stop();
  });

  describe("confirmOwns reads the ROW, not the cache", () => {
    it("the cache says owned but the row is deleted: false, and the cache is corrected", async () => {
      const src = fakeSource();
      src.set("c", "host-a", 1);
      const { guard, stop } = createPgOwnershipGuard("host-a", src.source);
      src.connect();
      await flush();
      src.del("c"); // notification not delivered yet
      expect(guard.owns(sid("c"))).toBe(true);
      expect(await guard.confirmOwns(sid("c"))).toBe(false);
      expect(guard.owns(sid("c"))).toBe(false);
      stop();
    });

    it("the row names another pod: false", async () => {
      const src = fakeSource();
      src.set("c", "host-a", 1);
      const { guard, stop } = createPgOwnershipGuard("host-a", src.source);
      src.connect();
      await flush();
      src.set("c", "host-b", 2);
      expect(await guard.confirmOwns(sid("c"))).toBe(false);
      stop();
    });

    it("a failed read is false: skip a cycle rather than risk a zombie", async () => {
      const src = fakeSource();
      src.set("c", "host-a", 1);
      const { guard, stop } = createPgOwnershipGuard("host-a", src.source);
      src.connect();
      await flush();
      src.failNext(new Error("pg down"));
      expect(await guard.confirmOwns(sid("c"))).toBe(false);
      expect(await guard.confirmOwns(sid("c"))).toBe(true); // the next read recovers
      stop();
    });
  });
});
