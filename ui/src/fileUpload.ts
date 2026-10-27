/**
 * Client-side helpers for the composer's file upload path, the non-image sibling of
 * imageUpload.ts. Images ride as vision content blocks; arbitrary files are
 * materialized into the sandbox at /workspace/uploads/<name> by the agent-host. This
 * module turns an attached File into a `{type:"file"}` content part carrying base64
 * bytes, and pulls those parts back out of a composer message so RuntimeProvider can
 * forward them to `agent.send(..., { files })`.
 */

import type {
  AttachmentAdapter,
  PendingAttachment,
  CompleteAttachment,
} from "@assistant-ui/react";

/** A file ready to send: base64 bytes (no data-url prefix) + name + mime. */
export interface OutboundFile {
  name: string;
  data: string;
  mimeType: string;
}

/** The upload caps (scooter.uploads), served by the agent-host in /whoami's `limits`. */
export interface UploadLimits {
  maxFileBytes: number;
  maxFilesPerMessage: number;
}

/** Used until /whoami answers (or if it carries no limits), matching the platform's
 *  defaults so attachments are never blocked on the fetch. */
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024,
  maxFilesPerMessage: 4,
});

let currentLimits: UploadLimits = DEFAULT_UPLOAD_LIMITS;

const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** Adopt the server's caps; a missing or malformed field keeps its default. */
export function setUploadLimits(limits: Partial<UploadLimits> | null | undefined): void {
  currentLimits = {
    maxFileBytes: positiveInt(limits?.maxFileBytes) ? limits.maxFileBytes : DEFAULT_UPLOAD_LIMITS.maxFileBytes,
    maxFilesPerMessage: positiveInt(limits?.maxFilesPerMessage)
      ? limits.maxFilesPerMessage
      : DEFAULT_UPLOAD_LIMITS.maxFilesPerMessage,
  };
}

/** The caps in effect now. */
export function uploadLimits(): UploadLimits {
  return currentLimits;
}

/** Bytes as a short MB label for error messages ("25MB", "1.5MB"). */
function mbLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : Number(mb.toFixed(1))}MB`;
}

/** base64 length -> byte size (0.75 ratio, minus '=' padding). */
export function base64Bytes(b64: string): number {
  if (!b64) return 0;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** Strip a `data:<mime>;base64,` prefix if present, since a file part holds bare
 *  base64 but a data URL is tolerated. */
function stripDataUrl(s: string): string {
  const m = /^data:[^;,]*;base64,(.+)$/s.exec(s);
  return m ? m[1] : s;
}

/** Pull the `{ type:"file", filename, data, mimeType }` parts out of an assistant-ui
 *  message content array, skipping parts without data and ignoring non-file parts. */
export function filesFromContent(content: unknown): OutboundFile[] {
  if (!Array.isArray(content)) return [];
  const out: OutboundFile[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as {
      type?: string;
      filename?: string;
      name?: string;
      data?: string;
      mimeType?: string;
    };
    if (p.type !== "file") continue;
    if (typeof p.data !== "string" || !p.data) continue;
    out.push({
      name: p.filename || p.name || "file",
      data: stripDataUrl(p.data),
      mimeType: p.mimeType || "application/octet-stream",
    });
  }
  return out;
}

/** Pull file parts out of a whole appended composer message, reading both
 *  `message.content` and `message.attachments[].content` because the composer keeps
 *  completed attachment content in the latter. */
export function filesFromMessage(message: unknown): OutboundFile[] {
  const m = message as { content?: unknown; attachments?: unknown };
  const out: OutboundFile[] = [...filesFromContent(m?.content)];
  if (Array.isArray(m?.attachments)) {
    for (const att of m.attachments) {
      out.push(...filesFromContent((att as { content?: unknown })?.content));
    }
  }
  return out;
}

/** Read a File's bytes as bare base64 (no data-url prefix). Browser-only (FileReader). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("unexpected file read result"));
        return;
      }
      resolve(stripDataUrl(result));
    };
    reader.readAsDataURL(file);
  });
}

// Monotonic id for pending attachments (avoids Date.now/Math.random for testability).
let attachmentSeq = 0;

/**
 * Attachment adapter for arbitrary files. It accepts "*", so in a
 * CompositeAttachmentAdapter placed after the image adapter it is the wildcard
 * fallback; send() reads the File into a `{type:"file"}` content part, which
 * RuntimeProvider forwards and the agent-host materializes into the sandbox. A file
 * over maxFileBytes, or one past maxFilesPerMessage pending files, is rejected at
 * add() time. The caps are read on each add(), so /whoami arriving later applies.
 *
 * The pending count is the adapter's own: assistant-ui calls remove() for every
 * pending attachment it drops (remove, reset, clear) and send() for every one it
 * sends, so the set tracks the composer. A failed send() keeps its id, since the
 * composer puts that attachment back.
 */
export class SandboxFileAttachmentAdapter implements AttachmentAdapter {
  // "*" is the composite's match-all sentinel ("*/*" is not).
  accept = "*";

  private readonly pending = new Set<string>();

  constructor(private readonly limits: () => UploadLimits = uploadLimits) {}

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    const { maxFileBytes, maxFilesPerMessage } = this.limits();
    if (file.size > maxFileBytes) {
      throw new Error(`"${file.name}" is too large to attach (max ${mbLabel(maxFileBytes)}).`);
    }
    if (this.pending.size >= maxFilesPerMessage) {
      throw new Error(`"${file.name}" wasn't attached: a message can carry at most ${maxFilesPerMessage} files.`);
    }
    const id = `file-${++attachmentSeq}`;
    this.pending.add(id);
    return {
      id,
      type: "document",
      name: file.name,
      contentType: file.type || "application/octet-stream",
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const data = await fileToBase64(attachment.file);
    const mimeType = attachment.file.type || "application/octet-stream";
    this.pending.delete(attachment.id);
    return {
      ...attachment,
      status: { type: "complete" },
      content: [{ type: "file", filename: attachment.name, data, mimeType }],
    };
  }

  async remove(attachment: { id: string }): Promise<void> {
    // No held resource (the bytes live only in the composer state until send()), just
    // the slot in the per-message count.
    this.pending.delete(attachment.id);
  }
}
