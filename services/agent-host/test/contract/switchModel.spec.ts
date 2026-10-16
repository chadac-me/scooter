/**
 * manager.switchModelNow, the immediate mid-turn switch the switch_model MCP tool
 * calls: cancel the live run, rebuild the agent with the new model, and re-nudge it to
 * continue, with the nudge strictly after the rebuild.
 */

import { describe, it, expect, vi } from "vitest";

import {
  createSessionManager,
  type SandboxProvisioner,
  type ConversationStore,
} from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SandboxRef, SessionId } from "../../src/types.js";

const fakeProvisioner = (): SandboxProvisioner => ({
  create: vi.fn(async (id) => ({ name: `conv-${id}`, namespace: "ns" }) as SandboxRef),
  suspend: vi.fn(async () => {}),
  resume: vi.fn(async (ref) => ref),
  destroy: vi.fn(async () => {}),
});

const inMemoryStore = (): ConversationStore => {
  const logs = new Map<SessionId, AguiEvent[]>();
  return {
    appendEvent: async (id, e) => {
      (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
    },
    async *readEvents(id) {
      yield* logs.get(id) ?? [];
    },
    gooseStatePath: (id) => `/state/${id}/goose`,
  };
};

/** A bridgeFactory recording each built bridge's model and an ordered call log across all bridges. */
function trackingFactory() {
  const built: Array<{ model?: string }> = [];
  const log: string[] = [];
  const factory = (args: { model?: string }) => {
    const idx = built.length;
    built.push({ model: args.model });
    return {
      start: vi.fn(async () => {}),
      prompt: vi.fn(async () => {
        log.push(`prompt#${idx}`);
        return "run-x";
      }),
      cancel: vi.fn(async () => {
        log.push(`cancel#${idx}`);
      }),
      stop: vi.fn(async () => {}),
      onEvent: () => () => {},
      onPersist: () => () => {},
      onTitle: () => () => {},
    } as never;
  };
  return { factory, built, log };
}

describe("switchModelNow (immediate mid-turn model switch)", () => {
  it("cancels the running turn, rebuilds goose with the NEW model, and re-nudges to continue", async () => {
    const { factory, built, log } = trackingFactory();
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory: factory });
    // Start on "opus", then a normal prompt so a live bridge exists.
    const conv = await sessions.start("thread-1", "opus");
    await sessions.prompt(conv.id, "do the thing");
    log.length = 0;

    const switched = await sessions.switchModelNow(conv.id, "sonnet");
    expect(switched).toBe(true);

    // The old bridge was cancelled and a new one ran the continue-nudge, in that order.
    expect(built[0].model).toBe("opus");
    expect(built.at(-1)!.model).toBe("sonnet");
    expect(log[0]).toMatch(/^cancel#/);
    expect(log.at(-1)).toMatch(/^prompt#/);
    // The continue prompt ran on a newer bridge than the one cancelled.
    const cancelIdx = Number(log[0].split("#")[1]);
    const promptIdx = Number(log.at(-1)!.split("#")[1]);
    expect(promptIdx).toBeGreaterThan(cancelIdx);

    expect(sessions.get(conv.id)?.model).toBe("sonnet");
  });

  it("is a no-op when the model is already current (no cancel, no rebuild)", async () => {
    const { factory, log } = trackingFactory();
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory: factory });
    const conv = await sessions.start("thread-1", "opus");
    await sessions.prompt(conv.id, "hi");
    log.length = 0;

    const switched = await sessions.switchModelNow(conv.id, "opus");
    expect(switched).toBe(false);
    expect(log).toEqual([]);
    expect(sessions.get(conv.id)?.model).toBe("opus");
  });

  it("ALWAYS leaves a live bridge on the new model (never tears down without rebuilding)", async () => {
    // applyModelSwitch alone leaves no bridge until the next prompt, which would strand the turn that called it.
    const { factory, built } = trackingFactory();
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory: factory });
    const conv = await sessions.start("thread-1", "opus");
    await sessions.prompt(conv.id, "work");

    await sessions.switchModelNow(conv.id, "sonnet");

    // A subsequent prompt must not need to build another bridge.
    const builtCount = built.length;
    await sessions.prompt(conv.id, "next");
    expect(built.length).toBe(builtCount);
    expect(built.at(-1)!.model).toBe("sonnet");
  });

  it("records WHO chose the model: the user's pick, then the agent's switch, then the user's again", async () => {
    const { factory } = trackingFactory();
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory: factory });
    const unset = await sessions.start("thread-0");
    expect(sessions.get(unset.id)?.modelSetBy).toBeUndefined();

    const conv = await sessions.start("thread-1", "opus");
    expect(sessions.get(conv.id)?.modelSetBy).toBe("user");

    await sessions.switchModelNow(conv.id, "sonnet");
    expect(sessions.get(conv.id)?.modelSetBy).toBe("agent");

    // A prompt that carries the model it already has changes nothing.
    await sessions.prompt(conv.id, "same", "sonnet");
    expect(sessions.get(conv.id)?.modelSetBy).toBe("agent");

    await sessions.prompt(conv.id, "back to opus", "opus");
    expect(sessions.get(conv.id)?.modelSetBy).toBe("user");
  });

  it("throws on an unknown conversation", async () => {
    const { factory } = trackingFactory();
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory: factory });
    await expect(sessions.switchModelNow("nope", "sonnet")).rejects.toThrow(/unknown conversation/);
  });
});
