/**
 * Cluster fixture: provider-agnostic Kubernetes access for the Tier 2 tests.
 *
 * Connects to whatever the current kubeconfig points at (cluster-up.sh brings the
 * cluster up). CLUSTER_PROVIDER selects existing | k3s | kind | minikube | k3d
 * (default k3s) and RUN_CLUSTER_TESTS=1 enables Tier 2 at all.
 */

import { setTimeout as sleep } from "node:timers/promises";

import {
  KubeConfig,
  CoreV1Api,
  BatchV1Api,
  CustomObjectsApi,
  KubernetesObjectApi,
  Exec,
  setHeaderOptions,
  PatchStrategy,
  type V1Status,
} from "@kubernetes/client-node";
import { Writable } from "node:stream";

export type ClusterProvider = "existing" | "k3s" | "kind" | "minikube" | "k3d";

export interface Cluster {
  readonly provider: ClusterProvider;
  apply(manifest: object): Promise<void>;
  /** Delete a Pod by name, best-effort. */
  deletePod(name: string, namespace?: string): Promise<void>;
  get<T = unknown>(kind: string, name: string, namespace?: string): Promise<T>;
  waitFor<T = unknown>(
    kind: string,
    name: string,
    predicate: (r: T) => boolean,
    timeoutMs?: number,
    namespace?: string,
  ): Promise<T>;
  exec(
    podSelector: string,
    command: string[],
    namespace?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Merge-patch a PV; a resourceVersion in the body makes a CAS. */
  mergePatchPv(name: string, body: object): Promise<void>;
  /** Run a curl from a throwaway in-cluster pod and return the response body.
   *  No body at all is a lost attach rather than an answer, so it is retried (curlPodWithRetry). */
  curlInCluster(url: string, opts?: CurlOptions): Promise<string>;

  /** curlInCluster plus a parse of the leading JSON value, since `kubectl run -i` can append stray lines after the payload. */
  curlJson<T = unknown>(url: string, opts?: CurlOptions): Promise<T>;
}

export type CurlOptions = {
  method?: string;
  body?: string;
  headers?: string[];
  timeoutMs?: number;
};

/** Parse the leading JSON value of `raw`, trying progressively shorter line prefixes and rethrowing the original error when none parses. */
export function parseLeadingJson<T = unknown>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const lines = raw.split("\n");
    for (let end = lines.length - 1; end >= 1; end--) {
      try {
        return JSON.parse(lines.slice(0, end).join("\n")) as T;
      } catch {
        /* keep shrinking */
      }
    }
    throw err;
  }
}

/** The response body in a `kubectl run --rm -i` curl's stdout, less the teardown line kubectl appends. */
export function curlPodBody(stdout: string): string {
  return stdout.replace(/pod "[^"]+" deleted.*$/s, "").trim();
}

/** Run `attempt` until it hands back a response body, within a time budget.
 *
 *  `kubectl run --rm -i` sometimes returns its teardown line and nothing else: the pod ran
 *  but the attach never streamed its output (seen when the node authorizer transiently 403s
 *  the kubelet's status update for a just-created pod). That is a lost transport, not an
 *  empty answer, and nothing downstream can tell the two apart — `curlJson` only sees
 *  "Unexpected end of JSON input" — so run a fresh pod instead. A retried request can repeat
 *  its side effect, which every endpoint the Tier 2 specs curl tolerates.
 *
 *  The budget is what keeps that from hiding a real regression: a lost attach comes back in
 *  seconds, while a front door that genuinely answers nothing burns the curl timeout first.
 *  Blind retries would turn the latter into a suite timeout, which says far less than the
 *  caller's own assertion on an empty body. So an attempt that spent the budget is the last. */
export async function curlPodWithRetry(
  attempt: (n: number) => Promise<{ stdout: string; stderr: string }>,
  describe: string,
  opts: { attempts?: number; delayMs?: number; budgetMs?: number } = {},
): Promise<string> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 2_000;
  const budgetMs = opts.budgetMs ?? 30_000;
  const start = Date.now();
  let lastStderr = "";
  let n = 0;
  while (n < attempts) {
    n += 1;
    const { stdout, stderr } = await attempt(n);
    const body = curlPodBody(stdout);
    if (body) return body;
    lastStderr = stderr.trim();
    if (Date.now() - start >= budgetMs) break;
    if (n < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  const tail = lastStderr ? `; last stderr: ${lastStderr}` : "";
  throw new Error(
    `${describe}: the curl pod returned no response body in ${n} attempt(s) over ${Math.round((Date.now() - start) / 1000)}s${tail}`,
  );
}

export interface ClusterFixtureOptions {
  namespace?: string;
  installController?: boolean;
  sandboxImage?: string;
}

export function clusterTestsEnabled(): boolean {
  return process.env.RUN_CLUSTER_TESTS === "1";
}

const provider = (): ClusterProvider =>
  (process.env.CLUSTER_PROVIDER as ClusterProvider) ?? "k3s";

// Map a CRD/core "kind" to its REST coordinates.
const RESOURCES: Record<string, { group: string; version: string; plural: string; core?: boolean }> = {
  Sandbox: { group: "agents.x-k8s.io", version: "v1beta1", plural: "sandboxes" },
  SandboxWarmPool: { group: "extensions.agents.x-k8s.io", version: "v1beta1", plural: "sandboxwarmpools" },
  SandboxClaim: { group: "extensions.agents.x-k8s.io", version: "v1beta1", plural: "sandboxclaims" },
  ServiceAccount: { group: "", version: "v1", plural: "serviceaccounts", core: true },
  PersistentVolumeClaim: { group: "", version: "v1", plural: "persistentvolumeclaims", core: true },
  PersistentVolume: { group: "", version: "v1", plural: "persistentvolumes", core: true },
  Pod: { group: "", version: "v1", plural: "pods", core: true },
  Job: { group: "batch", version: "v1", plural: "jobs" },
};

export async function withCluster(opts: ClusterFixtureOptions = {}): Promise<Cluster> {
  const namespace = opts.namespace ?? "agent-sandbox-test";
  const kc = new KubeConfig();
  kc.loadFromDefault();

  const core = kc.makeApiClient(CoreV1Api);
  const batch = kc.makeApiClient(BatchV1Api);
  const custom = kc.makeApiClient(CustomObjectsApi);
  const objects = KubernetesObjectApi.makeApiClient(kc);
  const execClient = new Exec(kc);

  const getResource = async <T>(kind: string, name: string, ns: string): Promise<T> => {
    const r = RESOURCES[kind];
    if (!r) throw new Error(`unknown kind: ${kind}`);
    if (kind === "Job") return (await batch.readNamespacedJob({ name, namespace: ns })) as T;
    if (r.core) {
      const fn =
        kind === "ServiceAccount"
          ? core.readNamespacedServiceAccount({ name, namespace: ns })
          : kind === "Pod"
            ? core.readNamespacedPod({ name, namespace: ns })
            : kind === "PersistentVolume"
              ? core.readPersistentVolume({ name })
              : core.readNamespacedPersistentVolumeClaim({ name, namespace: ns });
      return (await fn) as T;
    }
    return (await custom.getNamespacedCustomObject({
      group: r.group,
      version: r.version,
      namespace: ns,
      plural: r.plural,
      name,
    })) as T;
  };

  const podNameForSelector = async (selector: string, ns: string): Promise<string> => {
    const pods = await core.listNamespacedPod({ namespace: ns, labelSelector: selector });
    const running = pods.items.find((p) => p.status?.phase === "Running") ?? pods.items[0];
    if (!running?.metadata?.name) throw new Error(`no pod for selector ${selector}`);
    return running.metadata.name;
  };

  const cluster: Cluster = {
    provider: provider(),

    async apply(manifest: object) {
      // Server-side apply, falling back to create when the object does not exist yet.
      await objects.patch(manifest as never, undefined, undefined, "agent-sandbox-tests", true, {
        headers: { "Content-Type": "application/apply-patch+yaml" },
      } as never).catch(async () => {
        await objects.create(manifest as never);
      });
    },

    get(kind, name, ns = namespace) {
      return getResource(kind, name, ns);
    },

    async deletePod(name, ns = namespace) {
      await core
        .deleteNamespacedPod({ name, namespace: ns, gracePeriodSeconds: 0 })
        .catch(() => {});
    },

    async waitFor(kind, name, predicate, timeoutMs = 120_000, ns = namespace) {
      const deadline = Date.now() + timeoutMs;
      let last: unknown;
      while (Date.now() < deadline) {
        try {
          last = await getResource(kind, name, ns);
          if (predicate(last as never)) return last as never;
        } catch {
          /* not found yet */
        }
        await sleep(2000);
      }
      throw new Error(`waitFor ${kind}/${name} timed out after ${timeoutMs}ms`);
    },

    async exec(podSelector, command, ns = namespace) {
      const pod = await podNameForSelector(podSelector, ns);
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      const outS = new Writable({ write(c, _e, cb) { stdout += c.toString(); cb(); } });
      const errS = new Writable({ write(c, _e, cb) { stderr += c.toString(); cb(); } });
      await new Promise<void>((resolve, reject) => {
        execClient
          .exec(ns, pod, "sandbox", command, outS, errS, null, false, (s: V1Status) => {
            if (s.status !== "Success") {
              const cause = s.details?.causes?.find((c) => c.reason === "ExitCode");
              exitCode = cause?.message ? Number(cause.message) : 1;
            }
          })
          .then((ws) => {
            ws.on("close", () => resolve());
            ws.on("error", reject);
          })
          .catch(reject);
      });
      return { stdout, stderr, exitCode };
    },

    async mergePatchPv(name, body) {
      await core.patchPersistentVolume({ name, body }, setHeaderOptions("Content-Type", PatchStrategy.MergePatch));
    },

    async curlInCluster(url, opts = {}) {
      const args = ["-sS", "-m", String(Math.ceil((opts.timeoutMs ?? 30_000) / 1000))];
      if (opts.method) args.push("-X", opts.method);
      for (const h of opts.headers ?? []) args.push("-H", h);
      if (opts.body !== undefined) args.push("-d", opts.body);
      args.push(url);

      return curlPodWithRetry(
        () => {
          // A unique pod name per attempt, so `kubectl run --rm -i` never races a previous
          // pod's teardown.
          curlSeq += 1;
          const podName = `curltest-${Date.now().toString(36)}-${curlSeq}`;
          return kubectl([
            "run", podName,
            "-n", namespace,
            "--rm", "-i", "--restart=Never",
            "--image=curlimages/curl:latest",
            "--command", "--",
            "curl", ...args,
          ]);
        },
        `curl ${opts.method ?? "GET"} ${url}`,
      );
    },

    async curlJson(url, opts = {}) {
      return parseLeadingJson(await cluster.curlInCluster(url, opts));
    },
  };
  return cluster;
}

let curlSeq = 0;

import { execFile } from "node:child_process";

function kubectl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("kubectl", args, { maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      // `kubectl run --rm` exits non-zero on a non-zero container exit, so hand both streams back and let the caller decide.
      resolve({ stdout, stderr: stderr || err?.message || "" });
    });
  });
}
