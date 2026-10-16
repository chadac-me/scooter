/**
 * `web_fetch`, the one agent tool the agent-host serves itself; the SSRF guard is why
 * it is a tool rather than a curl the agent runs. A non-2xx maps to an isError result
 * carrying the real status, since a silently swallowed failure is one the agent retries.
 */

import { z } from "zod";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** An MCP tool result (matches mcpServer.ts's ToolResult). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** The external resource a conversation maps to, as recorded by the webhooks service in conversation_map; `resourceId` is source-specific (slack "<channel>:<thread_ts>", github "<owner>/<repo>#<number>", gitlab "<repo>!<iid>" or "<repo>#<iid>") or the resource's URL. */
export interface ResourceMapping {
  source: string;
  resourceType: string;
  resourceId: string;
  /** Slack keeps the channel/ts as their own columns too; prefer these if set. */
  slackChannel?: string;
  slackTs?: string;
}

/** Deps for `web_fetch`, which never touches the broker. */
export interface WebFetchDeps {
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

/** Hops followed before giving up. */
const MAX_REDIRECTS = 5;

// --- Result helpers ---------

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });

/** Fetch a URL's main text content, refusing internal/metadata addresses. */
export async function handleWebFetch(
  deps: WebFetchDeps,
  args: { url: string },
): Promise<ToolResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  let url = args.url;
  let res!: Response;
  // Redirects are followed by hand so every hop passes the SSRF guard.
  for (let hop = 0; ; hop++) {
    const guard = await ssrfCheck(url);
    if (!guard.ok) {
      return err(`web_fetch refused: ${guard.reason}${url === args.url ? "" : ` (redirected to ${url})`}`);
    }
    try {
      res = await doFetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "scooter-agent/1.0" },
      });
    } catch (e) {
      const cause = (e as Error & { cause?: Error }).cause?.message;
      return err(`web_fetch failed for ${url}: ${(e as Error).message}${cause ? ` (${cause})` : ""}`);
    }
    const location = res.headers.get("location");
    if (res.status < 300 || res.status > 399 || !location) break;
    if (hop >= MAX_REDIRECTS) return err(`web_fetch failed: more than ${MAX_REDIRECTS} redirects from ${args.url}`);
    try {
      url = new URL(location, url).toString();
    } catch {
      return err(`web_fetch failed: ${url} redirected to an invalid location`);
    }
  }
  if (!res.ok) return err(`web_fetch FAILED (HTTP ${res.status}) for ${url}.`);
  const MAX = 200_000; // cap the returned content
  const text = (await res.text()).slice(0, MAX);
  // Strip tags/scripts so the agent gets readable text.
  const stripped = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const from = url === args.url ? "" : `(redirected to ${url})\n\n`;
  return ok(from + (stripped || "(empty response)"));
}

// --- SSRF guard (static block-list + DNS-resolve check) ----------------

/** Reject internal, loopback, link-local, cloud-metadata and cluster addresses, resolving the hostname to catch DNS-rebinding. */
async function ssrfCheck(rawUrl: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${u.protocol}` };
  }
  const host = u.hostname.toLowerCase();
  // Obvious internal names.
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".cluster.local") ||
    host.endsWith(".svc") ||
    host.endsWith(".internal")
  ) {
    return { ok: false, reason: `internal host ${host}` };
  }
  // Resolve to IP(s) and reject any private/loopback/link-local/metadata address.
  const ips: string[] = [];
  if (isIP(host)) ips.push(host);
  else {
    try {
      const addrs = await lookup(host, { all: true });
      ips.push(...addrs.map((a) => a.address));
    } catch {
      return { ok: false, reason: `could not resolve ${host}` };
    }
  }
  for (const ip of ips) {
    if (isBlockedIp(ip)) return { ok: false, reason: `resolves to a blocked address (${ip})` };
  }
  return { ok: true };
}

/** True for loopback / RFC1918 / link-local (incl. 169.254.169.254 metadata) / ULA / ::1. */
function isBlockedIp(ip: string): boolean {
  if (ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 0) return true; // this-host
  return false;
}

// --- Registration --------------------------------------------------------------

/** Register `web_fetch`, which needs no broker and no credential. */
export function registerWebFetch(server: McpServer, deps: WebFetchDeps): void {
  server.registerTool(
    "web_fetch",
    {
      title: "Fetch a URL",
      description:
        "Fetch a public web page and return its readable text. Refuses internal/cluster/metadata " +
        "addresses. Use on a URL from a search result, or from a PR/issue.",
      inputSchema: { url: z.string().describe("The http(s) URL to fetch.") },
    },
    async (args) => (await handleWebFetch(deps, args)) as never,
  );
}
