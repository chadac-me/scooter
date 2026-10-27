/** Tier 2: host-root sandbox PVCs survive a move into a user namespace. */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-test";
const IMAGE = process.env.SANDBOX_OS_IMAGE ?? "agent-sandbox-os:latest";
const RUNTIME_CLASS = process.env.SANDBOX_RUNTIME_CLASS ?? "crun";
const POD = `userns-migration-${RUNTIME_CLASS || "default"}`;
const SELECTOR = `app=${POD}`;
const CLAIMS = { workspace: `${POD}-workspace`, store: `${POD}-scooter-rw` };

/** The provisioner's pod shape, with or without a user namespace. */
const pod = (userNamespace: boolean) => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: POD, namespace: NS, labels: { app: POD } },
  spec: {
    ...(userNamespace ? { hostUsers: false } : {}),
    ...(RUNTIME_CLASS ? { runtimeClassName: RUNTIME_CLASS } : {}),
    containers: [
      {
        name: "sandbox",
        image: IMAGE,
        imagePullPolicy: "Never",
        securityContext: {
          capabilities: { add: ["SYS_ADMIN"] },
          ...(userNamespace ? { procMount: "Unmasked" } : {}),
        },
        volumeMounts: [
          { name: "run", mountPath: "/run" },
          { name: "tmp", mountPath: "/tmp" },
          { name: "scooter-rw", mountPath: "/nix/.scooter-rw" },
          { name: "workspace", mountPath: "/workspace" },
        ],
      },
    ],
    volumes: [
      { name: "run", emptyDir: { medium: "Memory" } },
      { name: "tmp", emptyDir: { medium: "Memory" } },
      { name: "scooter-rw", persistentVolumeClaim: { claimName: CLAIMS.store } },
      { name: "workspace", persistentVolumeClaim: { claimName: CLAIMS.workspace } },
    ],
  },
});

const pvc = (name: string) => ({
  apiVersion: "v1",
  kind: "PersistentVolumeClaim",
  metadata: { name, namespace: NS },
  spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "2Gi" } } },
});

/** A directory output, which Nix renames into the store. */
const dirOutput = (tag: string) =>
  [
    'let cu = builtins.storePath (builtins.getEnv "CU"); in derivation {',
    `  name = "migration-${tag}-\${toString builtins.currentTime}";`,
    "  system = builtins.currentSystem;",
    '  builder = "/bin/sh";',
    `  args = [ "-c" "\${cu}/bin/mkdir -p $out/sub; echo ${tag} > $out/sub/f" ];`,
    "}",
  ].join("\n");
const BUILD =
  'export CU=$(dirname "$(dirname "$(readlink -f "$(command -v mkdir)")")"); nix-build --no-out-link -E "$1"';

maybe("a host-user sandbox migrated into a user namespace keeps its workspace and store", () => {
  let cluster: Cluster;
  let builtPath = "";

  const sh = (script: string, ...args: string[]) => cluster.exec(SELECTOR, ["sh", "-c", script, "_", ...args], NS);
  const ok = async (script: string, ...args: string[]) => {
    const r = await sh(script, ...args);
    expect(r.exitCode, `'${script}' failed: ${r.stderr}`).toBe(0);
    return r;
  };

  const settle = async () => {
    await cluster.waitFor<{ status: { phase: string } }>("Pod", POD, (p) => p.status?.phase === "Running", 180_000, NS);
    const deadline = Date.now() + 180_000;
    let state = "";
    for (;;) {
      state = (await sh("systemctl is-system-running")).stdout.trim();
      if (!["initializing", "starting", ""].includes(state) || Date.now() > deadline) break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    expect(["running", "degraded"]).toContain(state);
  };

  const replacePod = async (userNamespace: boolean) => {
    await cluster.deletePod(POD, NS);
    const deadline = Date.now() + 120_000;
    while (await cluster.get("Pod", POD, NS).then(() => true, () => false)) {
      if (Date.now() > deadline) throw new Error(`pod ${POD} did not terminate`);
      await new Promise((res) => setTimeout(res, 2000));
    }
    await cluster.apply(pod(userNamespace));
  };

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });
    await cluster.apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } }).catch(() => {});
    await cluster.apply(pvc(CLAIMS.workspace));
    await cluster.apply(pvc(CLAIMS.store));
    await cluster.apply(pod(false));
  }, 60_000);

  afterAll(async () => {
    if (process.env.KEEP_TEST_PODS === "1") return;
    await cluster?.deletePod(POD, NS).catch(() => {});
  });

  it("as host root: writes the workspace and builds into the store upper", async () => {
    await settle();
    const map = (await ok("cat /proc/self/uid_map")).stdout.trim().split(/\s+/);
    expect(map.slice(0, 2)).toEqual(["0", "0"]);
    await ok("mkdir -p /workspace/proj && echo kept > /workspace/proj/file");
    builtPath = (await ok(BUILD, dirOutput("before"))).stdout.trim().split("\n").pop()!;
    expect(builtPath).toMatch(/^\/nix\/store\//);
  }, 600_000);

  it("in a user namespace: boots on the same PVCs with pod root off host root", async () => {
    await replacePod(true);
    await settle();
    const [inside, outside] = (await ok("cat /proc/self/uid_map")).stdout.trim().split(/\s+/);
    expect(inside).toBe("0");
    expect(outside).not.toBe("0");
    expect((await ok("grep ' /nix/store ' /proc/self/mountinfo | grep scooter-store")).stdout).toContain("userxattr");
  }, 600_000);

  it("the workspace survives and stays writable", async () => {
    expect((await ok("cat /workspace/proj/file")).stdout.trim()).toBe("kept");
    await ok("echo more >> /workspace/proj/file && mkdir /workspace/proj/new && mv /workspace/proj/new /workspace/proj/renamed");
  });

  it("a store path built as host root is still there", async () => {
    expect((await ok(`cat ${builtPath}/sub/f`)).stdout.trim()).toBe("before");
    await ok(`nix-store --verify-path ${builtPath}`);
  });

  it("a directory-output build works in the migrated store", async () => {
    const out = (await ok(BUILD, dirOutput("after"))).stdout.trim().split("\n").pop()!;
    expect((await ok(`cat ${out}/sub/f`)).stdout.trim()).toBe("after");
  }, 300_000);
});
