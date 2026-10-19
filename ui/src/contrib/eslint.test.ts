/**
 * The contrib-tab import boundary (ui/eslint.config.js) must actually reject. A broken
 * glob or regex would make `lint:contrib` pass everything, so this lints the fixture
 * that breaks the rule on purpose and asserts every escape is reported, and lints the
 * allowed imports and asserts none is.
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

// Run as lint:contrib does: from the repo root, with the ui config passed explicitly.
const eslint = new ESLint({ cwd: repo, overrideConfigFile: "ui/eslint.config.js", ignore: false });

/** The no-restricted-imports messages for `code` linted as if it were a tab at `path`. */
async function restricted(code: string, path = "contrib/echo/ui/Probe.tsx"): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath: `${repo}${path}` });
  return res.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

describe("contrib tab import boundary", () => {
  it("rejects every escape in the lint fixture", async () => {
    const [res] = await eslint.lintFiles(["contrib/echo/ui/lint-fixture/EscapesBoundary.tsx"]);
    const lines = res.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.line);
    expect(lines).toEqual([4, 5]);
    // The message names the fix for whoever hits it.
    expect(res.messages[0].message).toContain("Add it to the SDK");
  }, 30_000);

  it.each([
    'import { viewStore } from "@/src/view";',
    'import { contribFetch } from "@/src/contrib/sdk-internal";',
    'import x from "../../aws/ui/SettingsTab";',
    'import x from "/workspace/ui/src/sessions";',
  ])("rejects %s", async (line) => {
    expect(await restricted(line)).toHaveLength(1);
  });

  it.each([
    'import { useWhoami } from "@/src/contrib/sdk";',
    'import { Button } from "@/components/ui/button";',
    'import { cn } from "@/lib/utils";',
    'import { useState } from "react";',
    'import { Row } from "./Row";',
  ])("allows %s", async (line) => {
    expect(await restricted(line)).toEqual([]);
  });
});
