/**
 * Contrib link labels (`ui.linkLabels`): a contrib's rules label its own links from their
 * URL, and the Linked panel and sidebar show the label before the title. The core UI knows
 * no provider's URL shapes, so with no rules served nothing is labelled.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { contribLinkLabels, loadContribManifest } from "./contribManifest.js";
import { linkBadge, linkLabel, linkName, type SessionLink } from "./sessions.js";
import { LinkedResourcesPanel } from "./LinkedResources.js";

/** Rules shaped as contrib/ui-manifest.nix emits them. */
const RULES = {
  linkLabels: {
    acme: [
      { url: "/change/([0-9]+)(?:[/?#]|$)", label: "!$1" },
      { url: "/ticket/([A-Z]+)-([0-9]+)", label: "$1-$2" },
    ],
  },
};

async function serve(doc: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => doc })) as unknown as typeof fetch);
  await loadContribManifest();
}

const acme = (url: string, title?: string): SessionLink => ({ source: "acme", resourceType: "change", url, ...(title ? { title } : {}) });

afterEach(() => vi.unstubAllGlobals());

describe("contrib link labels", () => {
  it("labels nothing without rules: the core UI has no URL shapes of its own", async () => {
    await serve({});
    expect(linkLabel({ source: "github", resourceType: "pull_request", url: "https://github.com/o/r/pull/7" })).toBeUndefined();
    expect(linkName({ source: "github", resourceType: "pull_request", url: "https://github.com/o/r/pull/7", title: "feat: x" })).toBe("feat: x");
  });

  it("uses the first matching rule, filling in its groups", async () => {
    await serve(RULES);
    expect(linkLabel(acme("https://acme.dev/change/42"))).toBe("!42");
    expect(linkLabel(acme("https://acme.dev/change/42/diff"))).toBe("!42");
    expect(linkLabel(acme("https://acme.dev/ticket/ENG-12"))).toBe("ENG-12");
    expect(linkLabel(acme("https://acme.dev/changes"))).toBeUndefined();
    expect(linkLabel({ source: "acme", resourceType: "change" })).toBeUndefined();
  });

  it("applies a contrib's rules only to its own source", async () => {
    await serve(RULES);
    expect(linkLabel({ source: "other", resourceType: "change", url: "https://acme.dev/change/42" })).toBeUndefined();
  });

  it("puts the label before the title, and leaves it off when the title has it", async () => {
    await serve(RULES);
    expect(linkName(acme("https://acme.dev/change/42", "fix: the thing"))).toBe("!42 fix: the thing");
    expect(linkName(acme("https://acme.dev/change/42"))).toBe("!42 acme change");
    expect(linkBadge(acme("https://acme.dev/change/42", "acme !42"))).toBeUndefined();
    // !4 inside !42 is a different label.
    expect(linkName(acme("https://acme.dev/change/4", "acme !42"))).toBe("!4 acme !42");
  });

  it("drops a rule that doesn't compile or is incomplete, keeping the rest", async () => {
    await serve({
      linkLabels: {
        acme: [{ url: "(", label: "x" }, { url: "/a" }, { url: "/change/([0-9]+)", label: "!$1" }],
        broken: "nope",
        empty: [{ url: "(", label: "x" }],
      },
    });
    expect(Object.keys(contribLinkLabels())).toEqual(["acme"]);
    expect(contribLinkLabels().acme).toHaveLength(1);
    expect(linkLabel(acme("https://acme.dev/change/9"))).toBe("!9");
  });

  it("shows the label in the Linked panel, muted, before the title", async () => {
    await serve(RULES);
    const html = renderToStaticMarkup(
      createElement(LinkedResourcesPanel, { links: [{ ...acme("https://acme.dev/change/1153", "feat: labels"), resourceType: "change" }] }),
    );
    expect(html).toMatch(/data-testid="linked-resource-label"[^>]*>!1153</);
    expect(html).toContain('title="!1153 feat: labels"');
  });
});
