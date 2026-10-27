/**
 * Contract tests for jobManager, the run_background job core, driven against a
 * fake exec client that records execs and serves scripted results, plus a fake
 * registry. start() must launch the command detached under the workspace jobs dir
 * and return without waiting; check() reads status, liveness and log in one probe.
 */

import { describe, it, expect, vi } from "vitest";

import {
  cleanOutput,
  createJobManager,
  DEFAULT_MAX_OUTPUT,
  JOBS_DIR,
  MAX_OUTPUT_CAP,
  noticeTail,
  type JobRecord,
} from "../../src/session/jobManager.js";
import type { SandboxApiClient } from "../../src/exec/sandboxExec.js";
import type { ExecRequest, ExecResult } from "../../src/types.js";

/** A fake exec client that records every execute() and lets a test script the ExecResult by joined command. */
function fakeClient(script?: (cmd: string) => Partial<ExecResult> | undefined) {
  const execs: string[] = [];
  const uploads: Array<{ path: string; content: string }> = [];
  const client: SandboxApiClient = {
    mode: "direct",
    async execute(req: ExecRequest): Promise<ExecResult> {
      const cmd = [req.command, ...(req.args ?? [])].join(" ");
      execs.push(cmd);
      const scripted = script?.(cmd);
      return { stdout: "", stderr: "", exitCode: 0, ...scripted };
    },
    async upload(path, content) {
      uploads.push({ path, content });
    },
    async download() {
      return "";
    },
  };
  return { client, execs, uploads };
}

/** Build the marker-delimited stdout that check()'s single probe parses. */
function probeOut(status: string, sizeBytes: number, log: string, alive: "y" | "n" = "y"): string {
  return `__STATUS__\n${status}\n__ALIVE__\n${alive}\n__SIZE__\n${sizeBytes}\n__LOG__\n${log}`;
}

function fakeRegistry() {
  const jobs = new Map<string, JobRecord[]>();
  return {
    registry: {
      async saveJob(id: string, job: JobRecord) {
        jobs.set(id, [job, ...(jobs.get(id) ?? [])]);
      },
      async listJobs(id: string) {
        return jobs.get(id) ?? [];
      },
      async updateJob(id: string, job: JobRecord) {
        const list = jobs.get(id) ?? [];
        const i = list.findIndex((j) => j.jobId === job.jobId);
        if (i >= 0) list[i] = job;
      },
    },
    jobs,
  };
}

const mgr = (client: SandboxApiClient, registry: ReturnType<typeof fakeRegistry>["registry"], newJobId = () => "job-1") =>
  createJobManager({ client: () => client, registry, newJobId });

describe("jobManager.start", () => {
  it("launches the command DETACHED under the workspace jobs dir and returns a jobId", async () => {
    const { client, execs } = fakeClient();
    const { registry, jobs } = fakeRegistry();
    const res = await mgr(client, registry).start("conv-1", "npm run build");

    expect(res.jobId).toBe("job-1");
    const launch = execs.find((c) => c.includes(`${JOBS_DIR}/job-1`));
    expect(launch, "a launch exec referencing the job dir").toBeTruthy();
    expect(launch).toMatch(/nohup|setsid/);
    expect(launch).toContain("npm run build");
    expect(jobs.get("conv-1")?.[0]).toMatchObject({ jobId: "job-1", command: "npm run build" });
  });

  it("creates the job dir BEFORE the backgrounded job (mkdir not racing the pid write)", async () => {
    // The mkdir must run in the foreground, before the `&`, so the job dir exists when the pid is written.
    const { client, execs } = fakeClient();
    const { registry } = fakeRegistry();
    await mgr(client, registry).start("conv-1", "sleep 1");

    const launch = execs.find((c) => c.includes(`${JOBS_DIR}/job-1`))!;
    const setsidAt = launch.indexOf("setsid");
    const mkdirAt = launch.indexOf("mkdir -p");
    const bgAt = launch.indexOf("&");
    const pidAt = launch.indexOf("/pid");
    expect(mkdirAt).toBeGreaterThanOrEqual(0);
    expect(mkdirAt).toBeLessThan(setsidAt);
    // A `;` between the mkdir and the setsid keeps the trailing `&` from backgrounding the mkdir too.
    expect(launch.slice(mkdirAt, setsidAt)).toContain(";");
    expect(pidAt).toBeGreaterThan(bgAt);
  });

  it("does NOT block on the command (start returns before it would finish)", async () => {
    const { client } = fakeClient((cmd) =>
      cmd.includes("sleep") ? { stdout: "", exitCode: 0 } : undefined,
    );
    const { registry } = fakeRegistry();
    const res = await mgr(client, registry).start("conv-1", "sleep 999");
    expect(res.jobId).toBeTruthy();
  });
});

describe("jobManager.check", () => {
  it("reports RUNNING when the status file does not exist yet", async () => {
    const { client } = fakeClient((cmd) => {
      // An empty status marker means running.
      if (cmd.includes("__STATUS__")) return { stdout: probeOut("", 12, "building...\n") };
      return undefined;
    });
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "npm run build", startedAt: 1 });

    const st = await mgr(client, registry).check("conv-1", "job-1");
    expect(st.state).toBe("running");
    expect(st.exitCode).toBeUndefined();
    expect(st.output).toContain("building...");
  });

  it("reports EXITED with the exit code once the status file is written", async () => {
    const { client } = fakeClient((cmd) => {
      if (cmd.includes("__STATUS__")) return { stdout: probeOut("0", 5, "done\n") };
      return undefined;
    });
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "npm run build", startedAt: 1 });

    const st = await mgr(client, registry).check("conv-1", "job-1");
    expect(st.state).toBe("exited");
    expect(st.exitCode).toBe(0);
    expect(st.output).toContain("done");
  });

  it("surfaces a NON-ZERO exit code", async () => {
    const { client } = fakeClient((cmd) => {
      if (cmd.includes("__STATUS__")) return { stdout: probeOut("17", 5, "boom\n") };
      return undefined;
    });
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "x", startedAt: 1 });
    const st = await mgr(client, registry).check("conv-1", "job-1");
    expect(st.state).toBe("exited");
    expect(st.exitCode).toBe(17);
  });

  it("reports UNKNOWN when the job dir is gone (cleaned up / pod recreated)", async () => {
    const { client } = fakeClient((cmd) =>
      cmd.includes("__STATUS__") ? { stdout: "__MISSING__\n" } : undefined,
    );
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "x", startedAt: 1 });
    const st = await mgr(client, registry).check("conv-1", "job-1");
    expect(st.state).toBe("unknown");
  });

  it("flags truncation when the log is larger than the tail cap", async () => {
    const { client } = fakeClient((cmd) =>
      // 2 MiB exceeds the default tail cap.
      cmd.includes("__STATUS__") ? { stdout: probeOut("0", 2 * 1024 * 1024, "…tail…") } : undefined,
    );
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "x", startedAt: 1 });
    const st = await mgr(client, registry).check("conv-1", "job-1");
    expect(st.truncated).toBe(true);
    expect(st.logPath).toContain("job-1/log");
  });
});

describe("jobManager.cleanup", () => {
  it("removes EXITED jobs' dirs older than the TTL (find on old status files)", async () => {
    const { client, execs } = fakeClient();
    const { registry } = fakeRegistry();
    await createJobManager({ client: () => client, registry }).cleanup("conv-1");
    const sweep = execs.find((c) => c.includes("find") && c.includes("status"));
    expect(sweep, "a find sweep over old status files").toBeTruthy();
    expect(sweep).toMatch(/-mmin \+10/);
    expect(sweep).toContain(JOBS_DIR);
  });

  it("honors a custom cleanupTtlMs", async () => {
    const { client, execs } = fakeClient();
    const { registry } = fakeRegistry();
    await createJobManager({ client: () => client, registry, cleanupTtlMs: 5 * 60000 }).cleanup("conv-1");
    expect(execs.find((c) => c.includes("find"))).toMatch(/-mmin \+5/);
  });
});

describe("jobManager.kill", () => {
  it("SIGTERM+SIGKILLs the job's PROCESS GROUP (kill -- -PGID) when running", async () => {
    const { client, execs } = fakeClient((cmd) =>
      cmd.includes("__KILLED__") ? { stdout: "__KILLED__\n" } : undefined,
    );
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "npm run build", startedAt: 1 });

    const res = await mgr(client, registry).kill("conv-1", "job-1");
    expect(res.outcome).toBe("killed");
    const killExec = execs.find((c) => c.includes("kill -TERM"));
    expect(killExec, "a kill exec").toBeTruthy();
    expect(killExec).toMatch(/kill -TERM -- -/);
    expect(killExec).toMatch(/kill -KILL -- -/);
  });

  it("reports already-exited when the job has finished (no kill)", async () => {
    const { client } = fakeClient((cmd) => (cmd.includes("__KILLED__") ? { stdout: "__EXITED__\n" } : undefined));
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "x", startedAt: 1 });
    const res = await mgr(client, registry).kill("conv-1", "job-1");
    expect(res.outcome).toBe("already-exited");
  });

  it("reports unknown when the job dir is gone", async () => {
    const { client } = fakeClient((cmd) => (cmd.includes("__KILLED__") ? { stdout: "__UNKNOWN__\n" } : undefined));
    const { registry } = fakeRegistry();
    const res = await mgr(client, registry).kill("conv-1", "nope");
    expect(res.outcome).toBe("unknown");
  });
});

describe("jobManager.list", () => {
  it("returns the conversation's registered jobs (durable registry)", async () => {
    const { client } = fakeClient();
    const { registry } = fakeRegistry();
    const m = mgr(client, registry, () => "job-A");
    await m.start("conv-1", "cmd A");
    const list = await m.list("conv-1");
    expect(list.map((j) => j.command)).toContain("cmd A");
  });
});

describe("jobManager.pollCompletions (the completion-watcher)", () => {
  const exitedProbe = () => probeOut("0", 5, "all done\n");
  const runningProbe = () => probeOut("", 3, "working\n");

  it("returns a job that has EXITED and marks it notified (once)", async () => {
    const { client } = fakeClient((cmd) => (cmd.includes("__STATUS__") ? { stdout: exitedProbe() } : undefined));
    const { registry, jobs } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "npm test", startedAt: 1 });

    const first = await mgr(client, registry).pollCompletions("conv-1");
    expect(first.map((s) => s.jobId)).toEqual(["job-1"]);
    expect(first[0].state).toBe("exited");
    expect(first[0].output).toContain("all done");
    expect(jobs.get("conv-1")?.[0].notifiedAt).toBeTruthy();

    const second = await mgr(client, registry).pollCompletions("conv-1");
    expect(second).toEqual([]);
  });

  it("does NOT return a still-RUNNING job (and doesn't mark it)", async () => {
    const { client } = fakeClient((cmd) => (cmd.includes("__STATUS__") ? { stdout: runningProbe() } : undefined));
    const { registry, jobs } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "sleep 999", startedAt: 1 });

    const done = await mgr(client, registry).pollCompletions("conv-1");
    expect(done).toEqual([]);
    expect(jobs.get("conv-1")?.[0].notifiedAt).toBeUndefined();
  });

  it("skips jobs already marked notified", async () => {
    const { client } = fakeClient((cmd) => (cmd.includes("__STATUS__") ? { stdout: exitedProbe() } : undefined));
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "x", startedAt: 1, notifiedAt: 999 });

    const done = await mgr(client, registry).pollCompletions("conv-1");
    expect(done).toEqual([]);
  });
});

describe("jobManager — a job whose process DIED without writing status", () => {
  const setup = async (probe: string) => {
    const { client } = fakeClient((cmd) => (cmd.includes("__STATUS__") ? { stdout: probe } : undefined));
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "nix build", startedAt: 1 });
    return mgr(client, registry);
  };

  it("THE REGRESSION: no status file + no process reports EXITED, not running", async () => {
    // `status` is written by the job's own shell on exit, so a process killed first never writes it.
    const st = await (await setup(probeOut("", 40, "building...\n", "n"))).check("conv-1", "job-1");
    expect(st.state).toBe("exited");
    expect(st.died).toBe(true);
    expect(st.exitCode).toBe(137);
  });

  it("a LIVE process with no status file is still running", async () => {
    const st = await (await setup(probeOut("", 40, "building...\n", "y"))).check("conv-1", "job-1");
    expect(st.state).toBe("running");
    expect(st.died).toBeUndefined();
  });

  it("a real exit code WINS over liveness (the process is gone because it finished)", async () => {
    const st = await (await setup(probeOut("0", 5, "done\n", "n"))).check("conv-1", "job-1");
    expect(st.state).toBe("exited");
    expect(st.exitCode).toBe(0);
    expect(st.died).toBeUndefined();
  });

  it("an UNREADABLE liveness answer is NOT treated as death", async () => {
    // Only a definite "n" means gone.
    const st = await (await setup(probeOut("", 40, "building...\n", "" as never))).check("conv-1", "job-1");
    expect(st.state).toBe("running");
  });

  it("pollCompletions ANNOUNCES a died job so the agent stops waiting", async () => {
    const done = await (await setup(probeOut("", 40, "building...\n", "n"))).pollCompletions("conv-1");
    expect(done).toHaveLength(1);
    expect(done[0].died).toBe(true);
  });
});

describe("jobManager.check output window", () => {
  const setup = async (size: number, log: string) => {
    const { client, execs } = fakeClient((cmd) =>
      cmd.includes("__STATUS__") ? { stdout: probeOut("0", size, log) } : undefined,
    );
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "x", startedAt: 1 });
    return { m: mgr(client, registry), execs, registry };
  };

  it("reads the default tail and clamps max_bytes to the cap", async () => {
    const { m, execs } = await setup(10, "x");
    await m.check("conv-1", "job-1");
    await m.check("conv-1", "job-1", { maxBytes: 10 * 1024 * 1024 });
    expect(execs[0]).toContain(`tail -c ${DEFAULT_MAX_OUTPUT} `);
    expect(execs[1]).toContain(`tail -c ${MAX_OUTPUT_CAP} `);
  });

  it("reads a window from an offset without trimming lines", async () => {
    const { m, execs } = await setup(1000, "rtial\nnext\n");
    const st = await m.check("conv-1", "job-1", { offset: 100, maxBytes: 12 });
    expect(execs[0]).toContain("tail -c +101 ");
    expect(execs[0]).toContain("head -c 12");
    expect(st.output).toBe("rtial\nnext\n");
    expect(st.start).toBe(100);
    expect(st.truncated).toBe(true);
  });

  it("starts a truncated tail at the next full line", async () => {
    const { m } = await setup(DEFAULT_MAX_OUTPUT + 500, "8\n190639\n190640\n");
    const st = await m.check("conv-1", "job-1");
    expect(st.output).toBe("190639\n190640\n");
    expect(st.start).toBe(500 + 2);
  });

  it("returns a small log whole and untruncated", async () => {
    const { m } = await setup(6, "a\nb\nc\n");
    const st = await m.check("conv-1", "job-1");
    expect(st.output).toBe("a\nb\nc\n");
    expect(st.truncated).toBe(false);
  });

  it("markNotified stops pollCompletions announcing the job", async () => {
    const { m, registry } = await setup(1, "x");
    await m.markNotified("conv-1", "job-1");
    expect(await m.pollCompletions("conv-1")).toEqual([]);
    expect((await registry.listJobs("conv-1"))[0].notifiedAt).toBeDefined();
  });
});

describe("cleanOutput", () => {
  it("keeps only the last frame of a carriage-return progress bar", () => {
    expect(cleanOutput("10%\r50%\r100%\ndone\r\n")).toBe("100%\ndone\n");
  });

  it("strips ANSI colors and stray control bytes", () => {
    expect(cleanOutput("\x1b[32mok\x1b[0m\x07 fine\ttab")).toBe("ok fine\ttab");
  });

  it("elides mostly-binary output", () => {
    expect(cleanOutput("\x00\x01\uFFFD\uFFFDab")).toMatch(/^\[binary output, \d+ bytes not shown\]$/);
  });
});

describe("noticeTail", () => {
  it("leaves short output alone", () => {
    expect(noticeTail("a\nb\n")).toEqual({ text: "a\nb", cut: false });
  });

  it("cuts long output to whole trailing lines", () => {
    const out = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const { text, cut } = noticeTail(out, 100);
    expect(cut).toBe(true);
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text.startsWith("line ")).toBe(true);
    expect(text.endsWith("line 999")).toBe(true);
  });
});
