/**
 * Fake backend orchestrator: boots the kube-less server stack the fast-e2e / dev harness
 * drives the UI against, as one Playwright webServer process (ephemeral Postgres → atlas
 * migrate → agent-host with the fake agent → conversation-router in ROUTER_DEV_MODE). The
 * router owns the conversation list, its events stream and create, served from Postgres,
 * and proxies everything else to the single agent-host; Playwright waits on the router's
 * /healthz, so when this process reports ready the whole chain is up. Teardown stops the
 * chain in reverse, including the detached Postgres that pg_ctl daemonized.
 *
 * Plain .mjs so it runs as a bare `node` webServer command. Requires on PATH:
 * `conversation-router`, postgres tools (initdb/pg_ctl/createdb), `atlas`, and node. Env
 * (all optional):
 *   E2E_ROUTER_PORT (8080)  E2E_AGENT_HOST_PORT (8079)  E2E_PG_PORT (55432)
 *   ROUTER_BIN (else `conversation-router` on PATH)
 *   LOCAL_STATE_PATH, MIRROR_STATE_PATH, GOOSE_MODEL, AGENT_AVAILABLE_MODELS
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, chownSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Postgres refuses to run as root, so when running as root the PG processes run as a
// non-root uid (default `nobody`, override via PGUID/PGGID) and the datadir is chowned to it.
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
const PG_AS = runningAsRoot
  ? { uid: Number(process.env.PGUID ?? 65534), gid: Number(process.env.PGGID ?? 65534) }
  : {};

// E2E_-prefixed so they cannot collide with the k8s service env a dev container inside k8s
// gets injected (AGENT_HOST_PORT=tcp://…).
const ROUTER_PORT = process.env.E2E_ROUTER_PORT ?? "8080";
const AGENT_HOST_PORT = process.env.E2E_AGENT_HOST_PORT ?? "8079";
const PG_PORT = process.env.E2E_PG_PORT ?? "55432";
const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const DSN = `postgres://postgres@127.0.0.1:${PG_PORT}/agent_host?sslmode=disable`;
// The webhooks DB owns the resource_links table, which agent-host writes and the router
// reads, so both must point at the same DB.
const WEBHOOKS_DSN = `postgres://postgres@127.0.0.1:${PG_PORT}/webhooks?sslmode=disable`;

const log = (msg) => console.log(`[fakeBackend] ${msg}`);
const fail = (msg) => {
  console.error(`[fakeBackend] FATAL: ${msg}`);
  cleanup();
  process.exit(1);
};

let tmp;
let pgStarted = false;
/** @type {import('node:child_process').ChildProcess[]} */
const children = [];

/** Run a setup command to completion; fail the whole stack on non-zero (nothing works without it). */
function must(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} exited ${r.status ?? r.signal}`);
}

async function waitForHealth(url, name, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        log(`${name} healthy (${url})`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  fail(`${name} did not become healthy within ${timeoutMs}ms (${url})`);
}

function cleanup() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  if (pgStarted && tmp) {
    // pg_ctl daemonizes postgres detached from this process, so it must be stopped explicitly.
    spawnSync("pg_ctl", ["-D", join(tmp, "data"), "-m", "immediate", "stop"], { stdio: "ignore", ...PG_AS });
    pgStarted = false;
  }
  if (tmp) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ---- boot sequence -----------------------------------------------------------------------------

tmp = mkdtempSync(join(tmpdir(), "scooter-e2e-pg-"));
const pgData = join(tmp, "data");
const pgSock = join(tmp, "sock");
mkdirSync(pgSock, { recursive: true });
if (runningAsRoot) {
  // The PG processes run as PG_AS; give them ownership of the dir tree they must write.
  chownSync(tmp, PG_AS.uid, PG_AS.gid);
  chownSync(pgSock, PG_AS.uid, PG_AS.gid);
}

log(`initdb → ${pgData}${runningAsRoot ? ` (as uid ${PG_AS.uid})` : ""}`);
must("initdb", ["-D", pgData, "-U", "postgres", "--auth=trust"], PG_AS);

log(`starting Postgres on 127.0.0.1:${PG_PORT}`);
must("pg_ctl", [
  "-D", pgData,
  "-o", `-k ${pgSock} -c listen_addresses=127.0.0.1 -c port=${PG_PORT}`,
  "-l", join(tmp, "pg.log"),
  "-w", "start",
], PG_AS);
pgStarted = true;

log("createdb agent_host");
must("createdb", ["-h", "127.0.0.1", "-p", PG_PORT, "-U", "postgres", "agent_host"], PG_AS);

log("atlas migrate apply (agent_host)");
must("atlas", ["migrate", "apply", "--dir", "file://agent_host/migrations", "--url", DSN], {
  cwd: join(REPO_ROOT, "lib/sql"),
});

log("createdb webhooks");
must("createdb", ["-h", "127.0.0.1", "-p", PG_PORT, "-U", "postgres", "webhooks"], PG_AS);

log("atlas migrate apply (webhooks)");
must("atlas", ["migrate", "apply", "--dir", "file://webhooks/migrations", "--url", WEBHOOKS_DSN], {
  cwd: join(REPO_ROOT, "lib/sql"),
});

// Spawn a long-lived child and tear the whole stack down if it dies unexpectedly, so
// Playwright fails fast rather than hanging.
function spawnService(name, cmd, args, env) {
  log(`starting ${name}: ${cmd} ${args.join(" ")}`);
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (!shuttingDown) fail(`${name} exited unexpectedly (code=${code} signal=${signal})`);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;

spawnService("agent-host", "node", [join(REPO_ROOT, "services/agent-host/dist/index.js")], {
  PORT: AGENT_HOST_PORT,
  GOOSE_BIN: "fake",
  // Force the fake sandbox (noop provisioner, no k8s) rather than letting agent-host infer it
  // from the environment.
  FAKE_SANDBOX: "1",
  LOCAL_STATE_PATH: process.env.LOCAL_STATE_PATH ?? "/tmp/agent-host-e2e",
  // Production's two-store topology (mirroredConversationStore only exists with MIRROR_STATE_PATH).
  MIRROR_STATE_PATH: process.env.MIRROR_STATE_PATH ?? "/tmp/agent-host-e2e-mirror",
  GOOSE_MODEL: process.env.GOOSE_MODEL ?? "model-default",
  AGENT_AVAILABLE_MODELS: process.env.AGENT_AVAILABLE_MODELS ?? "model-default,model-fast,model-smart",
  // The env is an explicit allowlist, and AGENT_MODELS_JSON carries the provider-tagged catalog that makes the picker render its grouped branch.
  ...(process.env.AGENT_MODELS_JSON ? { AGENT_MODELS_JSON: process.env.AGENT_MODELS_JSON } : {}),
  // Durable conversation metadata + event log in the ephemeral PG — the row the router lists and
  // hydrates from, and the source of the conversations_changed NOTIFY the router pushes.
  AGENT_HOST_DB_DSN: DSN,
  // Required with a DSN, since nothing else writes the row.
  CONVERSATION_ROUTER_URL: `http://127.0.0.1:${ROUTER_PORT}`,
  // Switches agent-host's link store from files to the shared PG resource_links table, so a link
  // POSTed here is visible to the router's list enrichment (see WEBHOOKS_DSN).
  WEBHOOKS_DB_DSN: WEBHOOKS_DSN,
});

const routerBin = process.env.ROUTER_BIN ?? "conversation-router";

// agent-host must be listening before the router verifies its /healthz proxy target; wait then boot.
await waitForHealth(`http://127.0.0.1:${AGENT_HOST_PORT}/healthz`, "agent-host");

spawnService("conversation-router", routerBin, [], {
  LISTEN_ADDR: `:${ROUTER_PORT}`,
  ROUTER_DEV_MODE: "1",
  AGENT_HOST_URL: `http://127.0.0.1:${AGENT_HOST_PORT}`,
  AGENT_HOST_DB_DSN: DSN,
  // Read-only handle on the same resource_links table agent-host writes, for list enrichment.
  WEBHOOKS_DB_DSN: WEBHOOKS_DSN,
});

await waitForHealth(`http://127.0.0.1:${ROUTER_PORT}/healthz`, "conversation-router");
log(`stack ready — UI should target http://localhost:${ROUTER_PORT}`);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    shuttingDown = true;
    cleanup();
    process.exit(0);
  });
}
// A leftover unhandled path must still tear PG down.
process.on("exit", () => {
  shuttingDown = true;
  cleanup();
});
