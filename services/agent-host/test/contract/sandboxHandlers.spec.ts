/**
 * Contract tests for the ACP sandbox client handlers under concurrency. Goose can
 * fire several bash tool calls at once, each a createTerminal -> terminalOutput ->
 * waitForTerminalExit -> releaseTerminal sequence over the same handler set keyed
 * by terminal id, so concurrent terminals must never share an id or a buffer.
 */

import { describe, it, expect } from "vitest";

import { createSandboxClientHandlers } from "../../src/acp/sandboxHandlers.js";
import type { ExecBackend, ExecRequest, TerminalHandle } from "../../src/types.js";

/** A fake ExecBackend whose spawned terminals are finished manually, in any order. */
function createControllableExec() {
  let seq = 0;
  const live = new Map<string, { resolve: (out: string, code: number) => void; output: string }>();

  const exec: ExecBackend = {
    async run(): Promise<never> {
      throw new Error("not used");
    },
    spawn(_req: ExecRequest): TerminalHandle {
      const id = `term-${++seq}`;
      const cbs = new Set<(c: string) => void>();
      let buffered = "";
      let resolveExit!: (e: { exitCode: number }) => void;
      const exitPromise = new Promise<{ exitCode: number }>((r) => (resolveExit = r));
      live.set(id, {
        output: "",
        resolve: (out, code) => {
          buffered += out;
          for (const cb of cbs) cb(out);
          resolveExit({ exitCode: code });
        },
      });
      return {
        id,
        onOutput(cb) {
          cbs.add(cb);
          if (buffered) cb(buffered);
        },
        waitForExit: () => exitPromise,
        async kill() {},
        async release() {
          cbs.clear();
        },
      };
    },
    async readTextFile() {
      return "";
    },
    async writeTextFile() {},
    async writeBinaryFile() {},
  };

  // Finish a spawned terminal by 1-based spawn order.
  const finish = (n: number, out: string, code: number) => {
    const entry = live.get(`term-${n}`);
    if (!entry) throw new Error(`no live terminal term-${n}`);
    entry.resolve(out, code);
  };

  return { exec, finish };
}

describe("ACP sandbox handlers — concurrent terminals", () => {
  it("three identical concurrent createTerminal calls get DISTINCT ids", async () => {
    const { exec } = createControllableExec();
    const h = createSandboxClientHandlers(exec);

    const reqs = await Promise.all(
      [0, 1, 2].map(() => h.createTerminal({ command: "bash", args: ["-c", "echo hi"] } as any)),
    );
    const ids = reqs.map((r) => r.terminalId);

    expect(new Set(ids).size).toBe(3);
  });

  it("each concurrent terminal keeps its OWN output + exit (no clobber, no hang)", async () => {
    const { exec, finish } = createControllableExec();
    const h = createSandboxClientHandlers(exec);

    const t1 = (await h.createTerminal({ command: "bash", args: ["-c", "x"] } as any)).terminalId;
    const t2 = (await h.createTerminal({ command: "bash", args: ["-c", "x"] } as any)).terminalId;
    const t3 = (await h.createTerminal({ command: "bash", args: ["-c", "x"] } as any)).terminalId;

    // An orphaned or overwritten handle would hang here.
    const exits = Promise.all([
      h.waitForTerminalExit({ terminalId: t1 } as any),
      h.waitForTerminalExit({ terminalId: t2 } as any),
      h.waitForTerminalExit({ terminalId: t3 } as any),
    ]);

    // Finish out of order.
    finish(2, "two", 2);
    finish(1, "one", 1);
    finish(3, "three", 3);

    const [e1, e2, e3] = await exits;
    expect([e1.exitCode, e2.exitCode, e3.exitCode]).toEqual([1, 2, 3]);

    expect((await h.terminalOutput({ terminalId: t1 } as any)).output).toBe("one");
    expect((await h.terminalOutput({ terminalId: t2 } as any)).output).toBe("two");
    expect((await h.terminalOutput({ terminalId: t3 } as any)).output).toBe("three");
  });

  it("releasing one terminal does NOT wipe a concurrent terminal's buffer", async () => {
    const { exec, finish } = createControllableExec();
    const h = createSandboxClientHandlers(exec);

    const t1 = (await h.createTerminal({ command: "bash", args: ["-c", "x"] } as any)).terminalId;
    const t2 = (await h.createTerminal({ command: "bash", args: ["-c", "x"] } as any)).terminalId;
    finish(1, "first", 0);
    finish(2, "second", 0);
    await h.waitForTerminalExit({ terminalId: t1 } as any);
    await h.waitForTerminalExit({ terminalId: t2 } as any);

    await h.releaseTerminal({ terminalId: t1 } as any);

    expect((await h.terminalOutput({ terminalId: t1 } as any)).output).toBe("");
    expect((await h.terminalOutput({ terminalId: t2 } as any)).output).toBe("second");
  });

  it("waitForTerminalExit on an unknown terminal THROWS (host bug, not a command failure)", async () => {
    // An unknown id reported as exitCode:1 would look like the agent's command failed.
    const { exec } = createControllableExec();
    const h = createSandboxClientHandlers(exec);
    await expect(h.waitForTerminalExit({ terminalId: "term-nope" } as any)).rejects.toThrow(
      /unknown terminalId/,
    );
  });
});

/**
 * A cancel that arrives before the terminal it means to kill. The Stop button is
 * live at RUN_STARTED but the terminal only registers once the tool call spawns
 * its shell, so killAllTerminals holds a kill for the next terminal; the hold is
 * consumed by one terminal and armed only for a user stop.
 */
function createKillTrackingExec() {
  const spawned: Array<{ id: string; killed: boolean }> = [];
  let seq = 0;
  const exec: ExecBackend = {
    async run(): Promise<never> {
      throw new Error("not used");
    },
    spawn(_req: ExecRequest): TerminalHandle {
      const rec = { id: `term-${++seq}`, killed: false };
      spawned.push(rec);
      return {
        id: rec.id,
        onOutput() {},
        waitForExit: () => new Promise<{ exitCode: number }>(() => {}),
        async kill() {
          rec.killed = true;
        },
        async release() {},
      };
    },
    async readTextFile() {
      return "";
    },
    async writeTextFile() {},
    async writeBinaryFile() {},
  };
  return { exec, spawned };
}

describe("ACP sandbox handlers — a cancel that beats its terminal", () => {
  const spawnTerminal = (h: ReturnType<typeof createSandboxClientHandlers>) =>
    h.createTerminal({ command: "sleep", args: ["20"] } as never);

  /** kill() is fired without await inside createTerminal, so let it land. */
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("a USER stop kills the terminal that registers just after it", async () => {
    const { exec, spawned } = createKillTrackingExec();
    const handlers = createSandboxClientHandlers(exec);

    await handlers.killAllTerminals(true);
    await spawnTerminal(handlers);
    await settle();

    expect(spawned[0]!.killed, "the late terminal must not survive the stop").toBe(true);
  });

  it("consumes the hold, so only ONE terminal dies per missed stop", async () => {
    const { exec, spawned } = createKillTrackingExec();
    const handlers = createSandboxClientHandlers(exec);

    await handlers.killAllTerminals(true);
    await spawnTerminal(handlers);
    await settle();
    expect(spawned[0]!.killed).toBe(true);

    // The next run's terminal belongs to a run nobody cancelled.
    await spawnTerminal(handlers);
    await settle();
    expect(spawned[1]!.killed, "a later run's terminal must survive").toBe(false);
  });

  it("internal preemption does NOT arm the hold", async () => {
    const { exec, spawned } = createKillTrackingExec();
    const handlers = createSandboxClientHandlers(exec);

    // applyPreemption cancels with nothing spawned yet, and the replacement shell must keep running.
    await handlers.killAllTerminals();
    await spawnTerminal(handlers);
    await settle();

    expect(spawned[0]!.killed, "the preempting run's own terminal must survive").toBe(false);
  });

  it("still kills terminals that are already live", async () => {
    const { exec, spawned } = createKillTrackingExec();
    const handlers = createSandboxClientHandlers(exec);

    await spawnTerminal(handlers);
    await handlers.killAllTerminals(true);

    expect(spawned[0]!.killed).toBe(true);
  });
});
