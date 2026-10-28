import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { countChanges, globRegex, parseRegistry, report, selectSuites } from "./bench-compare.mjs";

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

const TABLE = `| Benchmark | warm-store.base | warm-store.pr |
|---|:-:|:-:|
| reserve/380 (cpu) | 122 ms | 7.09 ms: 17.25x faster |
| list/380 (cpu) | 10 ms | 12 ms: 1.20x slower |
| Geometric mean | (ref) | 4.00x faster |`;

const files = (map) => (f) => map[f] ?? null;

describe("countChanges", () => {
  it("counts faster and slower rows, not the geometric mean", () => {
    expect(countChanges(TABLE)).toEqual({ faster: 1, slower: 1 });
  });

  it("counts nothing when pyperf hides every row", () => {
    expect(countChanges("Benchmark hidden because not significant (10): a, b")).toEqual({ faster: 0, slower: 0 });
  });
});

describe("report", () => {
  const suites = parseRegistry(REGISTRY);

  it("warns on a slowdown and embeds the table", () => {
    const out = report([suites[0]], files({ "warm-store.md": TABLE }), { baseRef: "0123456789" });
    expect(out.status).toBe("warn");
    expect(out.summary).toBe("benchmarks — 1 faster, 1 slower");
    expect(out.body).toContain("vs merge base `01234567`");
    expect(out.body).toContain("17.25x faster");
    expect(out.body).toContain("| Benchmark | base | PR |");
  });

  it("passes when nothing is significant", () => {
    const out = report([suites[0]], files({ "warm-store.md": "Benchmark hidden because not significant (2): a, b" }));
    expect(out).toMatchObject({ status: "pass", summary: "benchmarks — no change beyond noise" });
  });

  it("fails when a suite failed on the PR", () => {
    const out = report(suites, files({ "warm-store.md": TABLE, "other.failed": "" }));
    expect(out.status).toBe("fail");
    expect(out.summary).toContain("1 suite(s) FAILED");
  });

  it("notes a suite with no baseline without failing", () => {
    const out = report([suites[1]], files({ "other.nobase": "" }));
    expect(out.status).toBe("pass");
    expect(out.body).toContain("No baseline");
  });
});
