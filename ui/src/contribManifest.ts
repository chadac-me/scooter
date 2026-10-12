/**
 * The deployment's contrib UI metadata (brand rows, tool cards, filter chips),
 * fetched at runtime from `/contrib/manifest.json`, which the UI's nginx serves from
 * the contrib set that deployment enabled. Loading never throws: a 404, a network
 * error, a timeout or a malformed body all mean "no contribs", and the app renders
 * its built-ins. Rows are validated one at a time, so one malformed row costs its
 * own chip rather than the whole manifest.
 */

import type {
  ContribApproval,
  ContribIcon,
  ContribManifest,
  ContribSource,
  ContribToolCard,
} from "./contribTypes.js";

/** Same-origin by construction — see the nginx route in pkgs/ui-image. */
const ENDPOINT = "/contrib/manifest.json";

/** main.tsx blocks the first paint on this fetch, so a hung route must degrade to
 *  built-ins rather than a blank page. */
const TIMEOUT_MS = 1500;

const EMPTY: ContribManifest = {
  sources: {},
  toolCards: {},
  toolTitles: {},
  linkProviders: [],
  approvals: {},
};

let manifest: ContribManifest = EMPTY;

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asIcon(v: unknown): ContribIcon | undefined {
  const r = asRecord(v);
  return isStr(r.viewBox) && isStr(r.path) ? { viewBox: r.viewBox, path: r.path } : undefined;
}

function asSource(v: unknown): ContribSource | undefined {
  const r = asRecord(v);
  const icon = asIcon(r.icon);
  if (!icon || !isStr(r.label) || !isStr(r.color)) return undefined;
  return { label: r.label, color: r.color, icon, linkProvider: r.linkProvider === true };
}

function asToolCard(v: unknown): ContribToolCard | undefined {
  const r = asRecord(v);
  if (!isStr(r.provider) || !isStr(r.argKey) || !isStr(r.action)) return undefined;
  return { provider: r.provider, argKey: r.argKey, action: r.action };
}

/** An approval row; a partial row is dropped rather than defaulted, so the option
 *  stays live and the broker still enforces. */
function asApproval(v: unknown): ContribApproval | undefined {
  const r = asRecord(v);
  if (!isStr(r.gatedOption) || !isStr(r.blockedTitle) || !isStr(r.blockedHint)) return undefined;
  return { gatedOption: r.gatedOption, blockedTitle: r.blockedTitle, blockedHint: r.blockedHint };
}

/** Keep the rows that validate, drop the ones that don't. */
function rows<T>(v: unknown, as: (x: unknown) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, raw] of Object.entries(asRecord(v))) {
    const row = as(raw);
    if (row) out[key] = row;
  }
  return out;
}

/** Validate a fetched document into the normalized manifest without ever throwing. */
function parse(doc: unknown): ContribManifest {
  const d = asRecord(doc);
  const sources = rows(d.sources, asSource);
  return {
    sources,
    toolCards: rows(d.toolCards, asToolCard),
    toolTitles: rows(d.toolTitles, (v) => (isStr(v) ? v : undefined)),
    approvals: rows(d.approvals, asApproval),
    // A link provider whose source row failed validation would be a chip with no
    // icon, so it is dropped too.
    linkProviders: (Array.isArray(d.linkProviders) ? d.linkProviders : []).filter(
      (p): p is string => isStr(p) && p in sources,
    ),
  };
}

/** Fetch the deployment's contrib manifest and populate the getters below, resolving
 *  even without a manifest because a deployment with no contribs is the normal case. */
export async function loadContribManifest(): Promise<void> {
  // Each load is authoritative: a 404 or an error means this deployment serves no contribs.
  manifest = EMPTY;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, { cache: "no-store", signal: abort.signal });
    if (!res.ok) return;
    manifest = parse(await res.json());
  } catch {
    /* no manifest, no contribs — the app falls back to its own sources */
  } finally {
    clearTimeout(timer);
  }
}

/** Brand row per contrib, merged under the app's own sources (sourceIcon.tsx). */
export function contribSources(): Record<string, ContribSource> {
  return manifest.sources;
}

/** Tool-call message cards, keyed by tool name (toolCallView.ts). */
export function contribToolCards(): Record<string, ContribToolCard> {
  return manifest.toolCards;
}

/** registerTool titles accepted as a fallback -> the tool name they mean. */
export function contribToolTitles(): Record<string, string> {
  return manifest.toolTitles;
}

/** Sources offered as sidebar filter chips and "Show:" label modes (sessions.ts). */
export function contribLinkProviders(): readonly string[] {
  return manifest.linkProviders;
}

/** Approval gating per contrib name (InterruptPanel.tsx); absent means no gating. */
export function contribApprovals(): Record<string, ContribApproval> {
  return manifest.approvals;
}
