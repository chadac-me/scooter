import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureSettings } from "../src/settings.js";

const KEY = "chat.agentHost.allowSignedOutWhenUsable";
const file = () => join(mkdtempSync(join(tmpdir(), "vsc-settings-")), "User", "settings.json");

describe("ensureSettings", () => {
  it("creates a missing settings file", () => {
    const f = file();
    expect(ensureSettings(f)).toBe("created");
    expect(JSON.parse(readFileSync(f, "utf8"))[KEY]).toBe(true);
  });
  it("adds the key to existing JSON, keeping the user's settings", () => {
    const f = file();
    ensureSettings(f);
    writeFileSync(f, JSON.stringify({ "editor.fontSize": 15 }));
    expect(ensureSettings(f)).toBe("updated");
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ "editor.fontSize": 15, [KEY]: true });
  });
  it("respects a value the user already set", () => {
    const f = file();
    ensureSettings(f);
    writeFileSync(f, JSON.stringify({ [KEY]: false }));
    expect(ensureSettings(f)).toBe("unchanged");
    expect(JSON.parse(readFileSync(f, "utf8"))[KEY]).toBe(false);
  });
  it("never rewrites a JSONC file with comments", () => {
    const f = file();
    ensureSettings(f);
    const jsonc = '{\n  // mine\n  "editor.fontSize": 15\n}\n';
    writeFileSync(f, jsonc);
    const warnings: string[] = [];
    expect(ensureSettings(f, (m) => warnings.push(m))).toBe("skipped");
    expect(readFileSync(f, "utf8")).toBe(jsonc);
    expect(warnings[0]).toContain(KEY);
  });
});
