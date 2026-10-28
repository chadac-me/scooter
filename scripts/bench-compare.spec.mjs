import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compare, globRegex, parseRegistry, ratioInterval, render, selectSuites } from "./bench-compare.mjs";

const REGISTRY = `
suites:
  - id: warm-store
    app: bench-warm-store
    src: services/warm-store-controller
    noise: 5
    paths:
      - services/warm-store-controller/**
      - modules/warm-store-controller.nix
  - id: other
    app: bench-other
    src: services/other
    paths:
      - services/other/*.py
`;

/** One case's rounds, given each side's per-round medians. */
const rounds = (base, pr, extra = {}) => [
  ...base.map((value) => ({ suite: "warm-store", side: "base", case: "c", unit: "ms_cpu", value, ...extra })),
  ...pr.map((value) => ({ suite: "warm-store", side: "pr", case: "c", unit: "ms_cpu", value, ...extra })),
];

describe("parseRegistry", () => {
  it("reads suites, their paths, and defaults the noise floor", () => {
    const [ws, other] = parseRegistry(REGISTRY);
    expect(ws).toMatchObject({ id: "warm-store", src: "services/warm-store-controller", noise: 5 });
    expect(ws.paths).toEqual(["services/warm-store-controller/**", "modules/warm-store-controller.nix"]);
    expect(other.noise).toBe(5);
  });

  it("parses the committed registry", () => {
    const suites = parseRegistry(readFileSync(".github/benchmarks.yml", "utf8"));
    expect(suites.map((s) => s.id)).toContain("warm-store");
  });

  it("rejects a line it does not understand", () => {
    expect(() => parseRegistry("suites:\n  id: x\n")).toThrow(/cannot parse/);
  });
});

describe("selectSuites", () => {
  const suites = parseRegistry(REGISTRY);
  const ids = (changed) => selectSuites(suites, changed).map((s) => s.id);

  it("matches `**` across directories and `*` within one", () => {
    expect(ids(["services/warm-store-controller/bench/run.py"])).toEqual(["warm-store"]);
    expect(ids(["services/other/a.py"])).toEqual(["other"]);
    expect(ids(["services/other/sub/a.py"])).toEqual([]);
  });

  it("selects nothing for unrelated paths", () => {
    expect(ids(["docs/index.md", "services/warm-store-controllerx/a.py"])).toEqual([]);
  });

  it("escapes regex characters in a glob", () => {
    expect(globRegex("a.nix").test("aXnix")).toBe(false);
  });
});

describe("compare", () => {
  const suites = parseRegistry(REGISTRY);

  it("calls a clear speedup faster", () => {
    const cmp = compare(rounds([180, 182, 179, 185, 181], [7, 7.2, 6.9, 7.1, 7]), suites);
    expect(cmp.rows[0]).toMatchObject({ verdict: "faster", base: 181, pr: 7 });
    expect(cmp.faster).toBe(1);
  });

  it("calls a clear slowdown slower", () => {
    const cmp = compare(rounds([10, 10.1, 9.9, 10, 10.2], [13, 13.1, 12.9, 13, 13.2]), suites);
    expect(cmp.rows[0].verdict).toBe("slower");
    expect(render(cmp).status).toBe("warn");
  });

  it("does not count a change whose interval reaches inside the noise floor", () => {
    // Medians differ 10%, but the rounds overlap too much.
    const cmp = compare(rounds([10, 8, 12, 9, 11], [11, 9, 13, 10, 12]), suites);
    expect(cmp.rows[0].verdict).toBe("same");
    expect(render(cmp).status).toBe("pass");
  });

  it("needs three rounds a side for an interval", () => {
    const cmp = compare(rounds([10, 10], [20, 20]), suites);
    expect(cmp.rows[0]).toMatchObject({ verdict: "few", interval: null });
  });

  it("shows a PR-only case as new and a failed base as having no baseline", () => {
    const lines = [...rounds([], [5, 5, 5]), { suite: "warm-store", side: "base", failed: true }];
    const out = render(compare(lines, suites));
    expect(out.status).toBe("pass");
    expect(out.body).toMatch(/new case/);
    expect(out.body).toMatch(/did not run on the merge base/);
  });

  it("fails when the PR side cannot run", () => {
    const out = render(compare([{ suite: "warm-store", side: "pr", failed: true }], suites));
    expect(out.status).toBe("fail");
    expect(out.summary).toMatch(/FAILED/);
  });
});

describe("ratioInterval", () => {
  it("is reproducible and brackets the ratio of medians", () => {
    const a = ratioInterval([10, 11, 9, 10, 10], [20, 21, 19, 20, 20]);
    expect(a).toEqual(ratioInterval([10, 11, 9, 10, 10], [20, 21, 19, 20, 20]));
    expect(a[0]).toBeLessThanOrEqual(2);
    expect(a[1]).toBeGreaterThanOrEqual(2);
  });
});

describe("render", () => {
  it("summarises the counts and renders one table row per case", () => {
    const lines = [
      ...rounds([180, 182, 179], [7, 7.2, 6.9]),
      ...rounds([10, 10, 10], [10, 10, 10], { case: "d" }),
    ];
    const out = render(compare(lines, parseRegistry(REGISTRY)), { baseRef: "81210157abcdef" });
    expect(out.summary).toBe("benchmarks — 1 faster");
    expect(out.body).toMatch(/merge base `81210157`/);
    expect(out.body.split("\n").filter((l) => l.startsWith("| warm-store"))).toHaveLength(2);
  });
});
