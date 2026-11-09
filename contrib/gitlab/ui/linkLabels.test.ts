// The GitLab contrib's link labels (link_labels.json, its ui.linkLabels): "!N" for an MR, "#N" for an issue.

import { afterEach, describe, it, expect, vi } from "vitest";

import rules from "../link_labels.json";
import { loadContribManifest } from "../../../services/ui/src/contribManifest.js";
import { linkLabel, linkName } from "../../../services/ui/src/sessions.js";

const gl = (url: string, title?: string) => ({ source: "gitlab", resourceType: "merge_request", url, ...(title ? { title } : {}) });

afterEach(() => vi.unstubAllGlobals());

describe("gitlab link labels", () => {
  it("labels MRs with !N and issues with #N", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ linkLabels: { gitlab: rules } }) })));
    await loadContribManifest();

    expect(linkLabel(gl("https://gitlab.com/group/sub/proj/-/merge_requests/42"))).toBe("!42");
    expect(linkLabel(gl("https://gitlab.com/group/proj/-/merge_requests/42/diffs"))).toBe("!42");
    expect(linkLabel(gl("https://gitlab.com/group/proj/-/issues/9"))).toBe("#9");
    expect(linkLabel(gl("https://gitlab.com/group/proj/-/work_items/9"))).toBe("#9");
    expect(linkLabel(gl("https://gitlab.com/group/proj"))).toBeUndefined();
    expect(linkName(gl("https://gitlab.com/g/p/-/merge_requests/42", "fix: y"))).toBe("!42 fix: y");
  });
});
