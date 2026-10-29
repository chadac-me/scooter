/** preprocessFences: a claimed fence language is rewritten to the hyphen-free token assistant-ui keeps. */

import { describe, it, expect } from "vitest";

import { preprocessFences } from "./contribPanels.js";

const fence = "```";
const LANGS = ["scooter-embed"];

describe("preprocessFences", () => {
  it("rewrites an opening fence of a claimed language and nothing after it", () => {
    const src = `${fence}scooter-embed\nshare: x\n${fence}`;
    const out = preprocessFences(src, LANGS);
    expect(out).toMatch(/^```contribfence\w+\n/);
    expect(out).not.toContain(`${fence}scooter-embed`);
    expect(out).toContain("share: x");
    expect(out.endsWith(fence)).toBe(true);
  });

  it("rewrites the fence even after a preceding paragraph (the agent-reply shape)", () => {
    const src = `some text (exit 0):\n${fence}scooter-embed\nshare: x\n${fence}`;
    expect(preprocessFences(src, LANGS)).not.toContain(`${fence}scooter-embed`);
  });

  it("does not touch the language outside an opening fence", () => {
    const src = "talking about scooter-embed and `scooter-embed` inline";
    expect(preprocessFences(src, LANGS)).toBe(src);
  });

  it("leaves unclaimed languages, and every fence when nothing is claimed, alone", () => {
    const src = `${fence}scooter\nnot an embed\n${fence}\n${fence}scooter-embed\nx\n${fence}`;
    expect(preprocessFences(src, ["other"])).toBe(src);
    expect(preprocessFences(src, [])).toBe(src);
  });
});
