/**
 * Background-job orchestrator, running in the agent-host outside the pod. A job is a
 * process detached inside the sandbox pod with its command, combined stdout+stderr, exit
 * code and pid captured to files under JOBS_DIR on the workspace PVC, which the
 * agent-host reads on demand via one-shot exec. A per-conversation registry (Postgres)
 * records which jobs exist, and a completion watcher (pollCompletions) announces each
 * exited job to the agent exactly once.
 */

import type { SandboxApiClient } from "../exec/sandboxExec.js";
import type { SessionId } from "../types.js";

/** A background job's persisted registry entry. */
export interface JobRecord {
  jobId: string;
  command: string;
  /** ms epoch when start() launched it. */
  startedAt: number;
  /** ms epoch when the completion watcher announced this job's exit; set once so it notifies
   *  exactly once. */
  notifiedAt?: number;
}

/** The live state of a job, read from its in-pod files. */
export interface JobStatus {
  jobId: string;
  command: string;
  /** "running" until the status file exists or the process is gone, then "exited"; "unknown" when
   *  the job dir is gone. */
  state: "running" | "exited" | "unknown";
  /** Present only when state === "exited"; 137 for a `died` job, whose real code is unknowable. */
  exitCode?: number;
  /** The job's process is gone with no status file (killed before it could record an exit), so the
   *  exit code is a guess and the log stops wherever the process was. */
  died?: boolean;
  /** The captured log tail, bounded by maxOutputBytes. */
  output: string;
  /** True when `output` was truncated to the tail. */
  truncated: boolean;
  /** The in-pod path to the full log, removed by the cleanup sweep `cleanupTtlMs` after the job
   *  exits. */
  logPath: string;
}

export interface StartResult {
  jobId: string;
}

export interface JobManager {
  /** Launch `command` detached in the conversation's sandbox and return its jobId without waiting. */
  start(id: SessionId, command: string): Promise<StartResult>;
  /** Read a job's current state from its in-pod files. */
  check(id: SessionId, jobId: string): Promise<JobStatus>;
  /** List the conversation's known jobs (from the registry), newest first. */
  list(id: SessionId): Promise<JobRecord[]>;
  /** Remove the on-disk files of jobs that exited more than cleanupTtlMs ago; running jobs are
   *  never touched. */
  cleanup(id: SessionId): Promise<void>;
  /** Return the jobs that exited since the last poll and were not yet announced, marking them
   *  announced before returning so a failed injection cannot re-notify. */
  pollCompletions(id: SessionId): Promise<JobStatus[]>;
  /** Kill a running job with SIGTERM then SIGKILL to its whole process group (start() uses setsid,
   *  so PGID == pid); idempotent. */
  kill(id: SessionId, jobId: string): Promise<KillResult>;
}

export interface KillResult {
  jobId: string;
  /** "killed" sent the signals, "already-exited" found a status file, "unknown" found no such job. */
  outcome: "killed" | "already-exited" | "unknown";
}

/** Persist/read the per-conversation job registry (Postgres in prod, a fake in tests). */
export interface JobRegistry {
  saveJob(id: SessionId, job: JobRecord): Promise<void>;
  listJobs(id: SessionId): Promise<JobRecord[]>;
  /** Update an existing record in place by jobId, a no-op if absent; without it the watcher falls
   *  back to in-memory de-dupe. */
  updateJob?(id: SessionId, job: JobRecord): Promise<void>;
}

export interface JobManagerDeps {
  /** Resolve a conversation's exec client. */
  client: (id: SessionId) => SandboxApiClient | Promise<SandboxApiClient>;
  /** Durable per-conversation job registry. */
  registry: JobRegistry;
  /** The in-pod jobs dir (on the workspace PVC). Default JOBS_DIR. */
  jobsDir?: string;
  /** Cap the output returned by check() (tail). Default 64 KiB. */
  maxOutputBytes?: number;
  /** How long after a job exits its on-disk files are kept; default 10 min. */
  cleanupTtlMs?: number;
  /** Wall-clock ms, injectable for tests; defaults to Date.now. */
  now?: () => number;
  /** Mint a unique job id, injectable for tests. */
  newJobId?: () => string;
}

/** Default in-pod jobs dir, under /workspace so it lives on the workspace PVC rather than tmpfs. */
export const JOBS_DIR = "/workspace/.scooter/jobs";

const DEFAULT_MAX_OUTPUT = 64 * 1024;
const DEFAULT_CLEANUP_TTL = 10 * 60 * 1000;

/** POSIX-quote a string for embedding inside a single-quoted sh word. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function createJobManager(deps: JobManagerDeps): JobManager {
  const jobsDir = deps.jobsDir ?? JOBS_DIR;
  const maxOutput = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const cleanupTtlMs = deps.cleanupTtlMs ?? DEFAULT_CLEANUP_TTL;
  const now = deps.now ?? Date.now;
  const newJobId = deps.newJobId ?? (() => `job-${now().toString(36)}-${Math.floor(now() % 1e6)}`);

  const dir = (jobId: string) => `${jobsDir}/${jobId}`;
  const clientFor = (id: SessionId) => Promise.resolve(deps.client(id));
  // In-memory de-dupe backstop for registries without updateJob.
  const notifiedMem = new Set<string>();

  return {
    async start(id, command): Promise<StartResult> {
      const jobId = newJobId();
      const d = dir(jobId);
      const client = await clientFor(id);
      // setsid puts the command in its own process group and `status` is written only when the
      // command finishes (what check() keys on); the mkdir and cmd write run in the foreground and
      // only the setsid line is backgrounded, so the pid write cannot race the mkdir.
      const script =
        `mkdir -p ${d} && ` +
        `printf %s ${shSingleQuote(command)} > ${d}/cmd; ` +
        `setsid sh -c ${shSingleQuote(`${command}; printf %s "$?" > ${d}/status`)} ` +
        `> ${d}/log 2>&1 < /dev/null & ` +
        `printf %s "$!" > ${d}/pid`;
      const res = await client.execute({ command: "sh", args: ["-c", script] });
      if (res.exitCode !== 0) {
        throw new Error(`run_background: failed to launch job (${(res.stderr || res.stdout || "").trim()})`);
      }
      await deps.registry.saveJob(id, { jobId, command, startedAt: now() });
      return { jobId };
    },

    async check(id, jobId): Promise<JobStatus> {
      const d = dir(jobId);
      const client = await clientFor(id);
      const command = (await deps.registry.listJobs(id)).find((j) => j.jobId === jobId)?.command ?? "";
      // One exec reads the status file, liveness, log size and log tail; an absent job dir reads as
      // "unknown".
      const probe =
        `if [ ! -d ${d} ]; then echo __MISSING__; exit 0; fi; ` +
        `echo __STATUS__; [ -f ${d}/status ] && cat ${d}/status; echo; ` +
        // `status` is written by the job's own shell on exit, so a process killed before that
        // leaves no status file and needs a liveness probe.
        `echo __ALIVE__; if [ -f ${d}/pid ] && [ -d /proc/$(cat ${d}/pid) ]; then echo y; else echo n; fi; ` +
        `echo __SIZE__; wc -c < ${d}/log 2>/dev/null || echo 0; ` +
        `echo __LOG__; tail -c ${maxOutput} ${d}/log 2>/dev/null || true`;
      const res = await client.execute({ command: "sh", args: ["-c", probe] });
      const out = res.stdout ?? "";
      if (out.includes("__MISSING__")) {
        return { jobId, command, state: "unknown", output: "", truncated: false, logPath: `${d}/log` };
      }
      const statusRaw = section(out, "__STATUS__", "__ALIVE__").trim();
      const aliveRaw = section(out, "__ALIVE__", "__SIZE__").trim();
      const sizeRaw = section(out, "__SIZE__", "__LOG__").trim();
      const log = section(out, "__LOG__", null);
      const size = Number.parseInt(sizeRaw, 10) || 0;
      const exited = statusRaw !== "";
      // No status file and no process means the job died; only a negative liveness answer (`n`)
      // counts, since an unreadable /proc must not be read as death.
      const died = !exited && aliveRaw === "n";
      return {
        jobId,
        command,
        state: exited || died ? "exited" : "running",
        // 137 (128+SIGKILL) is the closest honest code for a killed job.
        exitCode: exited ? Number.parseInt(statusRaw, 10) : died ? 137 : undefined,
        died: died || undefined,
        output: log,
        truncated: size > maxOutput,
        logPath: `${d}/log`,
      };
    },

    async list(id): Promise<JobRecord[]> {
      return deps.registry.listJobs(id);
    },

    async cleanup(id): Promise<void> {
      const client = await clientFor(id);
      const ttlMin = Math.max(1, Math.ceil(cleanupTtlMs / 60000));
      // A job is done when its `status` file exists; `-mmin +N` matches status files older than the
      // TTL, and a running job has none.
      const script =
        `[ -d ${jobsDir} ] || exit 0; ` +
        `find ${jobsDir} -mindepth 2 -maxdepth 2 -name status -mmin +${ttlMin} ` +
        `-exec sh -c 'rm -rf "$(dirname "$1")"' _ {} \\; 2>/dev/null || true`;
      await client.execute({ command: "sh", args: ["-c", script] }).catch(() => {
        /* retries next sweep */
      });
    },

    async pollCompletions(id): Promise<JobStatus[]> {
      const jobs = await deps.registry.listJobs(id);
      // Only jobs not yet announced, in the registry or in this process's memory.
      const pending = jobs.filter((j) => !j.notifiedAt && !notifiedMem.has(j.jobId));
      if (pending.length === 0) return [];
      const done: JobStatus[] = [];
      for (const j of pending) {
        const st = await this.check(id, j.jobId).catch(() => undefined);
        if (!st || st.state === "running") continue; // still running
        // "exited" and "unknown" are both terminal, so mark both; only a real completion is
        // announced.
        notifiedMem.add(j.jobId);
        await deps.registry.updateJob?.(id, { ...j, notifiedAt: now() }).catch(() => {});
        if (st.state === "exited") done.push(st); // only announce a real completion
      }
      return done;
    },

    async kill(id, jobId): Promise<KillResult> {
      const d = dir(jobId);
      const client = await clientFor(id);
      // One exec decides and acts: no dir is unknown, a status file is already-exited, else SIGTERM
      // then SIGKILL the process group (PGID == pid thanks to setsid).
      const script =
        `if [ ! -d ${d} ]; then echo __UNKNOWN__; exit 0; fi; ` +
        `if [ -f ${d}/status ]; then echo __EXITED__; exit 0; fi; ` +
        `pid=$(cat ${d}/pid 2>/dev/null); ` +
        `if [ -z "$pid" ]; then echo __UNKNOWN__; exit 0; fi; ` +
        `kill -TERM -- -"$pid" 2>/dev/null; ` +
        `sleep 3; ` +
        `kill -KILL -- -"$pid" 2>/dev/null; ` +
        `echo __KILLED__`;
      const res = await client.execute({ command: "sh", args: ["-c", script] }).catch(() => undefined);
      const out = res?.stdout ?? "";
      if (out.includes("__UNKNOWN__")) return { jobId, outcome: "unknown" };
      if (out.includes("__EXITED__")) return { jobId, outcome: "already-exited" };
      return { jobId, outcome: "killed" };
    },
  };

  // Extract the text between two markers, excluding the start marker's line.
  function section(text: string, start: string, end: string | null): string {
    const i = text.indexOf(start);
    if (i < 0) return "";
    const from = i + start.length;
    const rest = text.slice(from).replace(/^\n/, "");
    if (end == null) return rest;
    const j = rest.indexOf(end);
    return j < 0 ? rest : rest.slice(0, j);
  }
}

