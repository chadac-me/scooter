/**
 * Client-side image helpers for the composer upload path: pull image parts out of
 * an assistant-ui message's content, and downscale/re-encode them under a byte cap
 * before they are sent.
 */

/** An image ready to send: raw base64 (no data-url prefix) + its mime. */
export interface OutboundImage {
  data: string;
  mimeType: string;
}

/** Default client cap (~5MB) — should track the agent-host ASSET_MAX_BYTES. */
export const CLIENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Longest edge we downscale to before re-encoding (keeps large screenshots sane). */
const MAX_EDGE = 2000;

/** Split a `data:<mime>;base64,<data>` URL into { mimeType, data } (no prefix). */
export function parseDataUrl(url: string): OutboundImage | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  return m ? { mimeType: m[1], data: m[2] } : null;
}

/** base64 length -> byte size (0.75 ratio, minus padding). */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** Pull the image parts out of an assistant-ui message content array, accepting both
 *  `{ type: "image", image: <data-url> }` and `{ type: "image", data, mimeType }`. */
export async function imagesFromContent(content: unknown): Promise<OutboundImage[]> {
  if (!Array.isArray(content)) return [];
  const out: OutboundImage[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; image?: string; data?: string; mimeType?: string };
    if (p.type !== "image") continue;
    // Our own { data, mimeType } shape.
    if (p.data && p.mimeType) {
      out.push({ data: p.data, mimeType: p.mimeType });
    }
    // assistant-ui's { image: <data-url> } shape.
    else if (typeof p.image === "string" && p.image.length > 0) {
      if (p.image.startsWith("data:")) {
        const parsed = parseDataUrl(p.image);
        if (parsed) out.push(parsed);
      }
      // The browser creates blob: URLs for pasted images; convert them to data: URLs.
      else if (p.image.startsWith("blob:")) {
        console.log("[imageUpload] Converting blob URL to data URL:", p.image.slice(0, 50));
        try {
          const dataUrl = await blobUrlToDataUrl(p.image);
          const parsed = parseDataUrl(dataUrl);
          if (parsed) out.push(parsed);
        } catch (e) {
          console.warn("[imageUpload] Failed to convert blob URL:", e);
        }
      }
    }
  }
  return out;
}

/**
 * Pull image parts out of a whole appended composer message, reading both
 * `message.content` and `message.attachments[].content`, because the composer keeps
 * each completed attachment's content in `message.attachments[]` rather than merging
 * it into `message.content`.
 */
export async function imagesFromMessage(message: unknown): Promise<OutboundImage[]> {
  const m = message as { content?: unknown; attachments?: unknown };
  const out: OutboundImage[] = [...(await imagesFromContent(m?.content))];
  if (Array.isArray(m?.attachments)) {
    for (const att of m.attachments) {
      const content = (att as { content?: unknown })?.content;
      out.push(...(await imagesFromContent(content)));
    }
  }
  return out;
}

/**
 * Downscale and re-encode a data-url image so its longest edge is at most MAX_EDGE
 * and its bytes at most maxBytes, stepping JPEG quality down until it fits and
 * returning null when it cannot be loaded.
 */
export async function downscaleImage(
  dataUrl: string,
  maxBytes = CLIENT_IMAGE_MAX_BYTES,
): Promise<OutboundImage | null> {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    console.warn("[imageUpload] downscaleImage called with invalid dataUrl:", typeof dataUrl);
    return null;
  }

  const src = parseDataUrl(dataUrl);
  if (!src) return null;
  // No canvas (SSR/tests) — pass through; the server still enforces the cap.
  if (typeof document === "undefined" || typeof Image === "undefined") return src;
  // Already under the cap, so skip the re-encode.
  if (base64Bytes(src.data) <= maxBytes) return src;

  const img = await loadImage(dataUrl).catch(() => null);
  if (!img) return src;
  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return src;
  
  try {
    ctx.drawImage(img, 0, 0, w, h);
  } catch (e) {
    console.warn("[imageUpload] Failed to draw image to canvas:", e);
    return src;
  }

  for (const q of [0.9, 0.8, 0.7, 0.6]) {
    try {
      const out = parseDataUrl(canvas.toDataURL("image/jpeg", q));
      if (out && base64Bytes(out.data) <= maxBytes) return out;
    } catch (e) {
      console.warn("[imageUpload] Failed to encode image at quality", q, e);
    }
  }
  // Last resort: the smallest-quality encode (server may still reject; UI warns).
  try {
    return parseDataUrl(canvas.toDataURL("image/jpeg", 0.5)) ?? src;
  } catch (e) {
    console.warn("[imageUpload] Failed final encode attempt:", e);
    return src;
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** Convert a blob: URL (which the browser creates for pasted images) to a data: URL. */
async function blobUrlToDataUrl(blobUrl: string): Promise<string> {
  const response = await fetch(blobUrl);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
