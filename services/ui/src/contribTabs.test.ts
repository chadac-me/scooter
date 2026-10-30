import { describe, expect, it } from "vitest";
import { bundledTabEntries } from "./contribTabs.js";

describe("bundledTabEntries", () => {
  // Keys must match the manifest's `<contrib>/ui/<file>.tsx` entries.
  it("keys real contrib modules by manifest entry", () => {
    expect(bundledTabEntries()).toContain("echo/ui/SettingsTab.tsx");
    for (const e of bundledTabEntries()) expect(e).toMatch(/^[a-z0-9-]+\/ui\/[^/]+\.tsx$/);
  });
});
