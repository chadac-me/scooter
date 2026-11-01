/**
 * `web_fetch`, the one agent tool the agent-host serves itself; the SSRF guard is why
 * it is a tool rather than a curl the agent runs. A non-2xx maps to an isError result
 * carrying the real status, since a silently swallowed failure is one the agent retries.
 *
 * The raw bytes of a response are capped (readCapped) before anything else runs, so a
 * huge page or file bounds memory regardless of what it turns out to be. HTML is then
 * converted to Markdown via @mozilla/readability (falling back to plain tag-stripping
 * when it finds no real article) and PDF text is pulled with pdfjs-dist; only the
 * resulting text is paged with offset/max_chars, mirroring check_background.
 */

import { z } from "zod";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

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

/** Raw bytes read before giving up; bounds memory. */
const MAX_RAW_BYTES = 5 * 1024 * 1024;

/** Default / max chars of converted text returned per call. */
const DEFAULT_MAX_CHARS = 20_000;
const MAX_CHARS_CAP = 100_000;

/** Below this, treat Readability's pick as a miss. */
const MIN_ARTICLE_CHARS = 40;

// --- Result helpers ---------

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });

/** Fetch a URL's main text content, refusing internal/metadata addresses. */
export async function handleWebFetch(
  deps: WebFetchDeps,
  args: { url: string; offset?: number; max_chars?: number },
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

  const { buf, truncated: rawTruncated } = await readCapped(res, MAX_RAW_BYTES);
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();

  let body: string;
  if (contentType.includes("application/pdf") || looksLikePdf(buf)) {
    try {
      body = (await extractPdfText(buf)).trim();
    } catch (e) {
      return err(`web_fetch: could not read the PDF at ${url}: ${(e as Error).message}`);
    }
  } else if (contentType.includes("html") || looksLikeHtml(buf)) {
    body = htmlToReadableText(buf.toString("utf8"), url);
  } else {
    body = buf.toString("utf8").trim();
  }

  const from = url === args.url ? "" : `(redirected to ${url})\n\n`;
  const page = paginate(body, args.offset, args.max_chars);
  const rawNote = rawTruncated
    ? ` The download was capped at ${(MAX_RAW_BYTES / (1024 * 1024)).toFixed(0)} MB, so the page may be incomplete.`
    : "";
  const hint = page.truncated
    ? `\n\n(showing chars ${page.start}-${page.end} of ${page.total}.${rawNote} Page with ` +
      `web_fetch(url, offset=${page.end}, max_chars ≤ ${MAX_CHARS_CAP}).)`
    : rawNote
      ? `\n\n(${rawNote.trim()})`
      : "";
  return ok(from + (page.slice || "(empty response)") + hint);
}

// --- Bounded download ----------------------------------------------------------

/** Read up to maxBytes, cancelling the stream once reached. */
async function readCapped(res: Response, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { buf: Buffer.alloc(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    if (total + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  return { buf: Buffer.concat(chunks, total), truncated };
}

// --- Content conversion ----------------------------------------------------------

/** Sniffs HTML when the server's content-type is missing or wrong. */
function looksLikeHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, 1024).toString("utf8").trimStart();
  return /^<(!doctype html|html|\?xml)/i.test(head) || /<[a-z][a-z0-9]*[\s/>]/i.test(head);
}

/** PDF magic bytes, checked even when content-type lies. */
function looksLikePdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** HTML -> Markdown via readability; falls back to tag-stripping. */
function htmlToReadableText(html: string, url: string): string {
  let article: ReturnType<Readability["parse"]> = null;
  try {
    const dom = new JSDOM(html, { url });
    article = new Readability(dom.window.document).parse();
  } catch {
    article = null;
  }
  const extractedChars = article?.textContent?.trim().length ?? 0;
  if (article?.content && extractedChars >= MIN_ARTICLE_CHARS) {
    const turndown = new TurndownService({ headingStyle: "atx" });
    const md = turndown.turndown(article.content).replace(/\n{3,}/g, "\n\n").trim();
    if (md) return article.title ? `# ${article.title}\n\n${md}` : md;
  }
  return stripTags(html);
}

/** Plain fallback: strip scripts/styles/tags down to text. */
function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract per-page text with pdfjs-dist's non-worker Node build. */
async function extractPdfText(buf: Buffer): Promise<string> {
  const task = getDocument({ data: new Uint8Array(buf), useSystemFonts: true });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
      page.cleanup();
    }
    return pages.join("\n\n");
  } finally {
    await task.destroy();
  }
}

// --- Paging (mirrors check_background's offset/max_bytes) ----------------------

interface Page {
  slice: string;
  truncated: boolean;
  start: number;
  end: number;
  total: number;
}

/** Slice text to max_chars from offset; reports if more remains. */
function paginate(text: string, offset?: number, maxChars?: number): Page {
  const start = Math.max(0, Math.floor(offset ?? 0));
  const n = Math.max(1, Math.min(Math.floor(maxChars ?? DEFAULT_MAX_CHARS), MAX_CHARS_CAP));
  const end = Math.min(text.length, start + n);
  return { slice: text.slice(start, end), truncated: start > 0 || end < text.length, start, end, total: text.length };
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
        "Fetch a public web page or PDF and return its readable content as Markdown (links and headings " +
        "kept), extracted with readability so nav/boilerplate is dropped — falls back to plain stripped text " +
        "when no real article is found. Refuses internal/cluster/metadata addresses. Large results are paged: " +
        `returns up to ${DEFAULT_MAX_CHARS} chars by default (max ${MAX_CHARS_CAP} via max_chars) and says the ` +
        "total length and next offset when truncated; pass that offset back to read on. Use on a URL from a " +
        "search result, or from a PR/issue.",
      inputSchema: {
        url: z.string().describe("The http(s) URL to fetch."),
        offset: z.number().int().nonnegative().optional().describe("Char offset to read from (default 0); page with the offset a truncated result reports."),
        max_chars: z.number().int().positive().optional().describe(`Chars to return (default ${DEFAULT_MAX_CHARS}, max ${MAX_CHARS_CAP}).`),
      },
    },
    async (args) => (await handleWebFetch(deps, args)) as never,
  );
}
