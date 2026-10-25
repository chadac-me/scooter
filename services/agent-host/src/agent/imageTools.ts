/**
 * view_image: returns an image file from the conversation's sandbox as MCP image content,
 * so an agent can look at a screenshot it took. goose's own `read_image` reads the
 * agent-host pod's filesystem, so this is the sandbox-side replacement.
 */

import type { SandboxApiClient } from "../exec/sandboxExec.js";

/** What buildServer needs to reach a conversation's sandbox. */
export interface ImageToolsWiring {
  /** Resolve a conversation's exec client. */
  client: (conversationId: string) => SandboxApiClient | Promise<SandboxApiClient>;
}

/** An MCP tool result that may carry an image. */
export interface ImageToolResult {
  [k: string]: unknown;
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

/** Image types the model accepts, keyed by lower-case extension. */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** The API rejects images over 5 MB. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Exit code the in-pod script uses to report an oversized file. */
const TOO_BIG_EXIT = 3;

/** The image mime type for `path`, or undefined when it is not a viewable image. */
export function imageMimeType(path: string): string | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? IMAGE_MIME[m[1].toLowerCase()] : undefined;
}

const err = (text: string): ImageToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Read `path` from the sandbox as base64, size-checked in the pod so an oversized file is never shipped. */
export async function handleViewImage(
  wiring: ImageToolsWiring,
  conversationId: string,
  args: { path: string },
): Promise<ImageToolResult> {
  const raw = (args?.path ?? "").trim();
  if (!raw) return err("view_image: path is required.");
  // Relative paths resolve against the workspace, like the other sandbox tools.
  const path = raw.startsWith("/") ? raw : `/workspace/${raw}`;
  const mimeType = imageMimeType(path);
  if (!mimeType) {
    return err(`view_image: ${path} is not a supported image (use .png, .jpg, .jpeg, .gif or .webp).`);
  }
  // Positional $1 keeps the path out of the script text, so no quoting is needed.
  const script =
    `sz=$(stat -c %s -- "$1") || exit 1; ` +
    `if [ "$sz" -gt ${IMAGE_MAX_BYTES} ]; then echo "$sz" >&2; exit ${TOO_BIG_EXIT}; fi; ` +
    `base64 -w0 -- "$1"`;
  try {
    const client = await wiring.client(conversationId);
    const res = await client.execute({ command: "sh", args: ["-c", script, "view_image", path], cwd: "/workspace", env: {} });
    if (res.exitCode === TOO_BIG_EXIT) {
      return err(
        `view_image: ${path} is ${res.stderr.trim()} bytes; images over ${IMAGE_MAX_BYTES} bytes cannot be viewed. ` +
          `Downscale or crop it first (e.g. with ImageMagick: magick in.png -resize 50% out.png).`,
      );
    }
    if (res.exitCode !== 0) {
      return err(`view_image failed for ${path}: ${(res.stderr || res.stdout).trim() || `exit ${res.exitCode}`}`);
    }
    const data = res.stdout.replace(/\s+/g, "");
    if (!data) return err(`view_image: ${path} is empty.`);
    return { content: [{ type: "image", data, mimeType }] };
  } catch (e) {
    return err(`view_image failed for ${path}: ${(e as Error)?.message ?? e}`);
  }
}
