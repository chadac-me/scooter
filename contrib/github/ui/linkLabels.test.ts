// The GitHub contrib's link labels (link_labels.json, its ui.linkLabels): "#N" for a PR or issue.

import { afterEach, describe, it, expect, vi } from "vitest";

import rules from "../link_labels.json";
import { loadContribManifest } from "../../../services/ui/src/contribManifest.js";
import { linkLabel, linkName } from "../../../services/ui/src/sessions.js";

const gh = (url: string, title?: string) => ({ source: "github", resourceType: "pull_request", url, ...(title ? { title } : {}) });

afterEach(() => vi.unstubAllGlobals());

describe("github link labels", () => {
  it("labels PRs and issues with their number", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ linkLabels: { github: rules } }) })));
    await loadContribManifest();

    expect(linkLabel(gh("https://github.com/chadac-me/scooter/pull/1153"))).toBe("#1153");
    expect(linkLabel(gh("https://github.com/chadac-me/scooter/pull/1153/files"))).toBe("#1153");
    expect(linkLabel(gh("https://github.com/chadac-me/scooter/pull/1153#issuecomment-1"))).toBe("#1153");
    expect(linkLabel(gh("https://github.com/chadac-me/scooter/issues/1117"))).toBe("#1117");
    expect(linkLabel(gh("https://github.com/chadac-me/scooter"))).toBeUndefined();
    expect(linkName(gh("https://github.com/o/r/pull/7", "feat: x"))).toBe("#7 feat: x");
    // The webhooks' "owner/repo #N" titles already carry it.
    expect(linkName(gh("https://github.com/o/app/pull/7", "o/app #7"))).toBe("o/app #7");
  });
});
