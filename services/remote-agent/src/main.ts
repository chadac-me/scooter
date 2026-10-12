/**
 * scooter-remote-agent entrypoint (the bring-your-own-Claude container).
 *
 *   scooter-remote-agent login                         one-time token entry (serves 127.0.0.1:34579
 *                                                       to paste a `claude setup-token`, exits when done)
 *   scooter-remote-agent --url <wss> --join <token>    run: ensure a Claude token (serving :34579 if
 *                                                       needed), then connect + drive
 *
 * The Claude subscription token lives only in the mounted volume and never reaches scooter;
 * the join token authenticates the container to scooter.
 */

import { readToken } from "./claudeCreds.js";
import { selectBackend } from "./agentBackend.js";
import "./echoBackend.js"; // self-registers
import { startLoginServer } from "./loginServer.js";
import { runRemoteAgentClient } from "./remoteAgentClient.js";
import { hostname } from "node:os";
import { generateDeviceKey, loadDeviceIdentity, saveDeviceIdentity } from "./deviceKey.js";

const log = (m: string) => console.log(`[remote-agent] ${m}`);

function parseArgs(argv: string[]): { cmd?: string; url?: string; join?: string; model?: string; backend?: string } {
  const out: { cmd?: string; url?: string; join?: string; model?: string; backend?: string } = {};
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("--")) out.cmd = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--url") out.url = rest[++i];
    else if (a === "--join") out.join = rest[++i];
    else if (a === "--model") out.model = rest[++i];
    else if (a === "--backend") out.backend = rest[++i];
  }
  return out;
}

/** Ensure a Claude setup token, serving the token-entry page until the user pastes one. */
async function ensureLogin(): Promise<string> {
  let token = await readToken();
  if (token) return token;
  const srv = startLoginServer(log);
  log(`No Claude token yet. Open ${srv.url} and paste your \`claude setup-token\` output.`);
  await srv.done;
  srv.close();
  token = await readToken();
  if (!token) throw new Error("token entry completed but no token found — check the volume");
  return token;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.cmd === "login") {
    if (await readToken()) {
      log("Claude token already present.");
      return;
    }
    const srv = startLoginServer(log);
    log(`Open ${srv.url} and paste your \`claude setup-token\` output.`);
    await srv.done;
    srv.close();
    log("Done. You can now run the agent.");
    return;
  }

  // A registered device needs no join token, so --join is only required when this container has never registered.
  const existing = await loadDeviceIdentity();
  if (!args.url || (!args.join && !existing)) {
    console.error("usage: scooter-remote-agent --url <wss://.../connect> --join <token>");
    console.error("   or: scooter-remote-agent login");
    console.error("(--join is only needed the FIRST time; after that this device is registered)");
    process.exit(2);
  }

  // Only a Claude backend needs the subscription token.
  const backend = selectBackend(args.backend);
  const oauthToken = backend.needsClaudeAuth ? await ensureLogin() : undefined;

  // The controller's HTTP base: the connect URL is ws://host/byoc/ws/<session-id> and the registration/challenge routes are siblings of `ws`, so strip the whole `/ws/<id>` tail.
  const httpBase = args.url.replace(/^ws/, "http").replace(/\/ws\/[^/]*\/?$/, "");

  // Exchange the short-lived join token for a device key once; if registration fails, still connect with the join token.
  if (!existing && args.join) {
    const key = generateDeviceKey();
    try {
      const res = await fetch(`${httpBase}/devices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ joinToken: args.join, publicKey: key.publicKeyPem, label: hostname() }),
      });
      if (res.ok) {
        const { deviceId } = (await res.json()) as { deviceId: string };
        await saveDeviceIdentity({ deviceId, ...key });
        log(`registered this device as ${deviceId} — future reconnects need no join token`);
      } else {
        log(`device registration failed (${res.status}); falling back to the join token`);
      }
    } catch (err) {
      log(`device registration unreachable (${String(err)}); falling back to the join token`);
    }
  } else if (existing) {
    log(`using registered device ${existing.deviceId}`);
  }

  log(`Claude ready. Connecting to ${args.url} …`);
  const client = runRemoteAgentClient({
    url: args.url,
    joinToken: args.join ?? "",
    challengeNonce: async () => {
      const r = await fetch(`${httpBase}/challenge`);
      if (!r.ok) throw new Error(`challenge ${r.status}`);
      return ((await r.json()) as { nonce: string }).nonce;
    },
    oauthToken,
    model: args.model,
    backend: args.backend,
    log,
  });
  process.on("SIGTERM", () => client.stop());
  process.on("SIGINT", () => client.stop());
  await client.closed;
}

void main().catch((err) => {
  console.error(`[remote-agent] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
