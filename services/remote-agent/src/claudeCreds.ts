/**
 * The user's Claude subscription token, stored only in the container's volume. The user
 * runs `claude setup-token` on their own machine (the OAuth authorize step needs a browser
 * hCaptcha attestation) and pastes the result into the /login page; the SDK consumes it as
 * CLAUDE_CODE_OAUTH_TOKEN and it never touches scooter.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/** Loosely validate a pasted value against the `sk-ant-oat…` setup-token prefix. */
export function looksLikeSetupToken(raw: string): boolean {
  return /^sk-ant-oat\d*-/.test(raw.trim());
}

/** Where the pasted token is persisted, a plain file in the mounted volume. */
export function tokenPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "setup-token");
}

/** Read the persisted setup token, or the CLAUDE_CODE_OAUTH_TOKEN env override. */
export async function readToken(): Promise<string | undefined> {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = (await readFile(tokenPath(), "utf8")).trim();
    if (raw) return raw;
  } catch {
    /* absent means not logged in */
  }
  return undefined;
}

/** Persist the pasted setup token to the volume (0600). */
export async function writeToken(token: string): Promise<void> {
  const p = tokenPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, token.trim() + "\n", { mode: 0o600 });
}
