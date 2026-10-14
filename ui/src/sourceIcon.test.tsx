/**
 * The linked-resource provider icons.
 *
 * SourceBadge is rendered to static markup for every known provider; rendering
 * invokes the icon component, so a dropped or renamed icon import (an undefined
 * `Icon`) throws here. A contrib's row is runtime data and is covered in
 * contribManifest.test.ts.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { sourceLabel, SourceBadge } from "./sourceIcon.js";

const KNOWN = ["github", "slack", "shell"];

describe("sourceIcon", () => {
  it("RENDERS a real icon for every known provider (catches a dropped icon import)", () => {
    for (const source of KNOWN) {
      // An undefined Icon throws here; the SVG assertion catches an empty render.
      const html = renderToStaticMarkup(createElement(SourceBadge, { source }));
      expect(html).toContain("source-icon");
      expect(html).toContain("<svg"); // a real react-icons component renders an <svg>
    }
  });

  it("renders a fallback (no <svg>) for an unknown provider without throwing", () => {
    const html = renderToStaticMarkup(createElement(SourceBadge, { source: "bitbucket" }));
    expect(html).toContain("source-icon");
    expect(html).not.toContain("<svg");
  });

  it("sourceLabel returns the brand label for known providers", () => {
    expect(sourceLabel("github")).toBe("GitHub");
    expect(sourceLabel("slack")).toBe("Slack");
    expect(sourceLabel("shell")).toBe("Shell");
  });

  it("sourceLabel falls back to the raw source for unknown providers", () => {
    expect(sourceLabel("bitbucket")).toBe("bitbucket");
  });
});
