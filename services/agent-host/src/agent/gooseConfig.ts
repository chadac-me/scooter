/**
 * goose's config.yaml, written best-effort; ACP sessions never read it, `developer`
 * is enabled by `--with-builtin` in index.ts, and the `available_tools` allowlist
 * never reaches goose.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { formatError, logger } from "../log.js";

const log = logger("agent-host");

/** The developer-extension tools goose's AcpTools redirects to the sandbox, excluding tree and read_image, which would run locally. */
const SANDBOX_ROUTED_TOOLS = ["read", "write", "edit", "shell"];

/** Write goose's config.yaml under `home`, enabling developer with only the sandbox-routed tools. */
export function writeGooseConfig(home: string): void {
  const dir = join(home, ".config", "goose");
  mkdirSync(dir, { recursive: true });
  const yaml = [
    "extensions:",
    "  developer:",
    "    enabled: true",
    "    type: builtin",
    "    name: developer",
    "    display_name: Developer",
    "    timeout: 300",
    // Only the tools goose's AcpTools redirects to the sandbox.
    "    available_tools:",
    ...SANDBOX_ROUTED_TOOLS.map((t) => `      - ${t}`),
    "",
  ].join("\n");
  writeFileSync(join(dir, "config.yaml"), yaml, "utf8");
}

/** Write the config; fatal=true rejects startup on an unset or unwritable $HOME, since goose keeps its session db there. */
export function ensureGooseConfig(
  home: string | undefined,
  opts: { fatal: boolean },
): void {
  if (!home) {
    if (opts.fatal) {
      throw new Error(
        "goose config: $HOME is unset on a real deployment — goose keeps its session " +
          "db and state under $HOME, so it cannot run correctly. Refusing to start.",
      );
    }
    return; // fake/dev has nothing to configure
  }
  try {
    writeGooseConfig(home);
    log.info("wrote goose config.yaml (ignored by ACP sessions; developer comes from --with-builtin)", {
      path: join(home, ".config", "goose"),
    });
  } catch (e) {
    if (opts.fatal) {
      throw new Error(
        `goose config: failed to write ${home}/.config/goose — $HOME is unusable, so ` +
          `goose cannot keep its session db or state. Refusing to start. ` +
          `Cause: ${(e as Error)?.message ?? e}`,
        { cause: e },
      );
    }
    log.warn("failed to write goose config (non-fatal, fake sandbox)", { error: formatError(e) });
  }
}
