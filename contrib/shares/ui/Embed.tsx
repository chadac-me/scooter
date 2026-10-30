/**
 * The `scooter-embed` fence (`ui.markdownFences`): renders a published static share
 * (/s/<uuid>/) as a sandboxed, fixed-width <iframe> inline in the conversation, driven
 * by a fenced markdown block the agent emits:
 *
 *     ```scooter-embed
 *     share: 7f3c2a1e-1b2c-4d5e-8f90-abcdef012345   # uuid or /s/<uuid>/ path
 *     width: 720      # optional px (clamped)
 *     height: 480     # optional px
 *     center: true    # optional, centers the frame in the message
 *     ```
 *
 * The src is always rebuilt as `/s/<uuid>/` from a validated UUID, so an agent can
 * only point the frame at a share, and the sandbox omits allow-same-origin so the frame
 * runs in an opaque origin that cannot read the parent, cookies or same-origin storage.
 */

import type { MarkdownFenceProps } from "@/src/contrib/sdk";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 420;
const MIN_WIDTH = 160;
const MAX_WIDTH = 1200;
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 4000;

export interface ShareEmbedSpec {
  uuid: string;
  width: number;
  height: number;
  center: boolean;
}

export type ShareEmbedParse =
  | { ok: true; spec: ShareEmbedSpec }
  | { ok: false; error: string };

/** Pull a share UUID out of a bare uuid, a `/s/<uuid>/` path, or a full share URL. */
export function extractShareUuid(raw: string): string | null {
  const s = raw.trim();
  if (UUID_RE.test(s)) return s.toLowerCase();
  const m = s.match(/\/s\/([0-9a-fA-F-]{36})(?:[/?#]|$)/);
  if (m && UUID_RE.test(m[1])) return m[1].toLowerCase();
  return null;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Parse a `scooter-embed` fence body (simple `key: value` lines). */
export function parseShareEmbed(body: string): ShareEmbedParse {
  const fields: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf(":");
    if (i === -1) continue;
    fields[t.slice(0, i).trim().toLowerCase()] = t.slice(i + 1).trim();
  }
  const uuid = extractShareUuid(fields.share ?? fields.uuid ?? fields.src ?? "");
  if (!uuid) {
    return { ok: false, error: "scooter-embed: `share:` must be a share UUID or a /s/<uuid>/ path" };
  }
  return {
    ok: true,
    spec: {
      uuid,
      width: clampInt(fields.width, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH),
      height: clampInt(fields.height, DEFAULT_HEIGHT, MIN_HEIGHT, MAX_HEIGHT),
      center: /^(true|yes|1|center|centre)$/i.test(fields.center ?? ""),
    },
  };
}

export default function Embed({ body }: MarkdownFenceProps) {
  const parsed = parseShareEmbed(body);
  if (!parsed.ok) {
    return (
      <div
        data-testid="share-embed-error"
        className="my-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        {parsed.error}
      </div>
    );
  }
  const { uuid, width, height, center } = parsed.spec;
  const src = `/s/${uuid}/`;
  return (
    <div
      data-testid="share-embed"
      className="my-3"
      style={center ? { display: "flex", justifyContent: "center" } : undefined}
    >
      <iframe
        src={src}
        title={`shared page ${uuid}`}
        loading="lazy"
        referrerPolicy="no-referrer"
        // No allow-same-origin: keep the frame in an opaque origin.
        sandbox="allow-scripts allow-popups"
        className="aui-share-embed rounded-xl border border-border/60 bg-background"
        style={{ width, height, maxWidth: "100%" }}
      />
    </div>
  );
}
