/**
 * Tier 2: the one-shot mirror-to-Postgres event backfill Job renders and runs in a real cluster.
 *
 * The Job rendered from modules/event-backfill.nix mounts the history-mirror PVC, connects to the
 * agent_host Postgres with the platform's credentials, loads the event logs and exits non-zero if
 * anything fails to verify. This spec builds that manifest and asserts its shape, seeds the mirror
 * and proves the rows land, and seeds a corrupt conversation and proves the Job fails rather than
 * reporting success. Gated on RUN_CLUSTER_TESTS=1 against the deployed platform-manifests-k3d;
 * nothing else mounts the mirror PVC, so seeding it is safe.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadAllYaml, type V1Job, type V1Pod } from "@kubernetes/client-node";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;

const NS = "agent-sandbox";
const MIRROR_PVC = "agent-host-history";
const SEEDER = "backfill-seeder";
const SEEDER_IMAGE = "busybox:1.36";
const PSQL_IMAGE = "postgres:16-alpine";

const execFileP = promisify(execFile);

/** A raw kubectl call that throws with stderr on failure. */
async function kubectl(args: string[]): Promise<string> {
  const { stdout } = await execFileP("kubectl", args, { maxBuffer: 16 << 20 });
  return stdout;
}

/** Run one command in a throwaway `kubectl run --rm` pod, returning its stdout even when the container exits non-zero. */
let podSeq = 0;
async function runOnce(image: string, env: Record<string, string>, argv: string[]): Promise<string> {
  podSeq += 1;
  const name = `bf-${Date.now().toString(36)}-${podSeq}`;
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  const args = [
    "run", name, "-n", NS, "--rm", "-i", "--restart=Never", "--image", image,
    ...envArgs, "--command", "--", ...argv,
  ];
  try {
    const out = await kubectl(args);
    return out.replace(/pod "[^"]+" deleted.*$/s, "").trim();
  } catch (e) {
    const err = e as { stdout?: string };
    if (err.stdout) return err.stdout.replace(/pod "[^"]+" deleted.*$/s, "").trim();
    throw e;
  }
}

/** The agent_host Postgres password from the platform's Secret, so psql runs as the same role the backfill writes as. */
async function agentHostPassword(): Promise<string> {
  const b64 = (await kubectl([
    "get", "secret", "agent-pg-agent-host", "-n", NS, "-o", "jsonpath={.data.password}",
  ])).trim();
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Run a single-value query as the agent_host role, returning only the last non-empty line because `kubectl run -i` occasionally duplicates the captured stdout. */
async function psql(pw: string, query: string): Promise<string> {
  const out = await runOnce(
    PSQL_IMAGE,
    { PGPASSWORD: pw },
    ["psql", "-h", "agent-shared-db", "-U", "agent_host", "-d", "agent_host", "-tAc", query],
  );
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

/** A valid AG-UI event line in the shape the contract test uses. */
const ev = (n: number): string =>
  JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId: `m${n}`, delta: `d${n}`, ts: n });

/** Seed conversation logs onto the mirror PVC under `<mirrorRoot>/<id>/events.jsonl` via the seeder pod, wiping the root first. */
async function seedMirror(mirrorRoot: string, tree: Record<string, string[]>): Promise<void> {
  const parts: string[] = [`set -e`, `rm -rf ${mirrorRoot}`];
  for (const [id, lines] of Object.entries(tree)) {
    const dir = `${mirrorRoot}/${id}`;
    parts.push(`mkdir -p ${dir}`);
    if (lines.length > 0) {
      const b64 = Buffer.from(lines.join("\n") + "\n", "utf8").toString("base64");
      // Base64 keeps the JSON quoting intact through the shell.
      parts.push(`echo ${b64} | base64 -d > ${dir}/events.jsonl`);
    }
  }
  await kubectl(["exec", SEEDER, "-n", NS, "-c", "seed", "--", "sh", "-c", parts.join(" && ")]);
}

/** Clone the rendered Job into a uniquely named instance with its own mirror sub-path and optional backoffLimit. */
function jobInstance(
  rendered: V1Job,
  name: string,
  mirrorRoot: string,
  opts: { backoffLimit?: number } = {},
): V1Job {
  const job: V1Job = JSON.parse(JSON.stringify(rendered));
  job.metadata = { name, namespace: NS, labels: job.metadata?.labels };
  const spec = job.spec!;
  if (opts.backoffLimit !== undefined) spec.backoffLimit = opts.backoffLimit;
  const container = spec.template.spec!.containers[0];
  // Only the mirror-path argument is overridden; image, DB env, volume and SA stay as rendered.
  container.command = ["agent-host-backfill", mirrorRoot];
  return job;
}

/** Wait until a Job has finished and return its status. */
async function waitJobDone(cluster: Cluster, name: string, timeoutMs = 180_000) {
  const job = await cluster.waitFor<V1Job>(
    "Job",
    name,
    (j) => (j.status?.succeeded ?? 0) >= 1 || (j.status?.failed ?? 0) >= 1,
    timeoutMs,
    NS,
  );
  return job.status ?? {};
}

maybe("event backfill Job renders and runs in a real cluster", () => {
  let cluster: Cluster;
  let renderedJob: V1Job;
  let pw: string;
  const createdJobs: string[] = [];

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });

    // Build the rendered Job from the module.
    const built = (await execFileP(
      "nix",
      ["build", ".#platform-manifests-k3d-backfill", "--no-link", "--print-out-paths"],
      { maxBuffer: 16 << 20 },
    )).stdout.trim();
    const yaml = await execFileP("cat", [built], { maxBuffer: 32 << 20 });
    const docs = loadAllYaml(yaml.stdout) as Array<{ kind?: string; metadata?: { name?: string } }>;
    const job = docs.find((d) => d.kind === "Job" && d.metadata?.name === "agent-event-backfill");
    expect(job, "the rendered manifest must contain the agent-event-backfill Job").toBeTruthy();
    renderedJob = job as unknown as V1Job;

    pw = await agentHostPassword();

    // Ensure the event log table exists as the agent_host role so the Job can insert into it.
    await psql(
      pw,
      `CREATE TABLE IF NOT EXISTS conversation_events (
         conversation_id text NOT NULL,
         seq bigint NOT NULL,
         event jsonb NOT NULL,
         checksum text NOT NULL,
         prev_checksum text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (conversation_id, seq));`,
    );

    // A long-lived seeder pod mounting the mirror PVC read-write.
    await cluster.deletePod(SEEDER, NS).catch(() => {});
    const seeder: V1Pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: SEEDER, namespace: NS, labels: { app: SEEDER } },
      spec: {
        restartPolicy: "Never",
        securityContext: { fsGroup: 0 },
        containers: [
          {
            name: "seed",
            image: SEEDER_IMAGE,
            command: ["sh", "-c", "sleep 3600"],
            volumeMounts: [{ name: "mirror", mountPath: "/mirror" }],
          },
        ],
        volumes: [{ name: "mirror", persistentVolumeClaim: { claimName: MIRROR_PVC } }],
      },
    };
    await cluster.apply(seeder);
    await cluster.waitFor<V1Pod>("Pod", SEEDER, (p) => p.status?.phase === "Running", 120_000, NS);
  });

  afterAll(async () => {
    for (const name of createdJobs) {
      await kubectl(["delete", "job", name, "-n", NS, "--ignore-not-found", "--wait=false"]).catch(
        () => {},
      );
    }
    await cluster.deletePod(SEEDER, NS).catch(() => {});
    // Drop the seeded rows so the shared agent_host DB is left as it was found.
    if (pw) {
      await psql(pw, `DELETE FROM conversation_events WHERE conversation_id LIKE 'backfill-e2e-%'`).catch(
        () => {},
      );
    }
  });

  it("renders a Job with the agent-host image, DB wiring, and a read-only mirror mount", () => {
    const spec = renderedJob.spec!;
    const podSpec = spec.template.spec!;
    const c = podSpec.containers[0];

    expect(c.image, "uses an agent-host image").toMatch(/agent-host/);
    // The packaged bin resolves the script by absolute store path; the image has no WorkingDir.
    expect(c.command).toEqual(["agent-host-backfill", "/mirror/conversations"]);

    // The same agent_host DB wiring the live service uses.
    const envNames = (c.env ?? []).map((e) => e.name);
    expect(envNames).toContain("AGENT_HOST_DB_HOST");
    expect(envNames).toContain("AGENT_HOST_DB_PASSWORD");
    expect(envNames).not.toContain("DATABASE_URL");
    const pwEnv = (c.env ?? []).find((e) => e.name === "AGENT_HOST_DB_PASSWORD");
    expect(pwEnv?.valueFrom?.secretKeyRef?.name).toBe("agent-pg-agent-host");

    // The mirror is the only copy of un-migrated history, so it must be mounted read-only.
    const mount = (c.volumeMounts ?? []).find((m) => m.mountPath === "/mirror");
    expect(mount?.readOnly).toBe(true);
    const vol = (podSpec.volumes ?? []).find((v) => v.name === mount?.name);
    expect(vol?.persistentVolumeClaim?.claimName).toBe(MIRROR_PVC);
    expect(podSpec.serviceAccountName).toBe("agent-host");
  });

  it("loads every seeded conversation's events into Postgres and exits 0", async () => {
    const run = `t${Date.now().toString(36)}`;
    const root = `/mirror/${run}/conversations`;
    const convA = `backfill-e2e-${run}-a`;
    const convB = `backfill-e2e-${run}-b`;
    const tree = { [convA]: [ev(1), ev(2), ev(3)], [convB]: [ev(1), ev(2)] };
    await seedMirror(root, tree);

    const jobName = `agent-event-backfill-${run}`;
    createdJobs.push(jobName);
    await cluster.apply(jobInstance(renderedJob, jobName, root));

    const status = await waitJobDone(cluster, jobName);
    expect(status.succeeded, `job status: ${JSON.stringify(status)}`).toBe(1);
    expect(status.failed ?? 0).toBe(0);

    // Independent confirmation that the rows landed, one per seeded line.
    expect(Number(await psql(pw, `SELECT count(*) FROM conversation_events WHERE conversation_id = '${convA}'`))).toBe(3);
    expect(Number(await psql(pw, `SELECT count(*) FROM conversation_events WHERE conversation_id = '${convB}'`))).toBe(2);
    // seq is dense and 1-based.
    expect(await psql(pw, `SELECT max(seq) FROM conversation_events WHERE conversation_id = '${convA}'`)).toBe("3");
  });

  it("FAILS the whole run when one conversation is corrupt (never a false success)", async () => {
    const run = `t${Date.now().toString(36)}-bad`;
    const root = `/mirror/${run}/conversations`;
    const good = `backfill-e2e-${run}-good`;
    const bad = `backfill-e2e-${run}-bad`;
    // One valid conversation and one with a malformed line; a single failure must fail the run.
    await seedMirror(root, { [good]: [ev(1)], [bad]: ["{ not json"] });

    const jobName = `agent-event-backfill-${run}`;
    createdJobs.push(jobName);
    // backoffLimit 0 surfaces the failure after a single attempt.
    await cluster.apply(jobInstance(renderedJob, jobName, root, { backoffLimit: 0 }));

    const status = await waitJobDone(cluster, jobName);
    expect(status.failed ?? 0, `job status: ${JSON.stringify(status)}`).toBeGreaterThanOrEqual(1);
    expect(status.succeeded ?? 0).toBe(0);
  });
});
