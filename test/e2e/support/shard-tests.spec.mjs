import { describe, expect, it } from "vitest";

import { packTests, reportWeights, resolveWeights, testKey } from "./shard-tests.mjs";

const e2e = (title, file = "a.spec.ts") => ({ kind: "e2e", file: `test/e2e/${file}`, title });
const cluster = (title) => ({ kind: "cluster", file: "test/cluster/platform-smoke.spec.ts", title });

describe("reportWeights", () => {
  // The merged report carries both kinds now (scripts/merge-e2e-full-reports.mjs), and
  // testKey is per kind: keying every spec as `e2e` would file the cluster durations
  // under names no test has, and the smoke would be packed at the flat default forever.
  it("keys each spec by the kind the merge tagged it with", () => {
    const w = reportWeights({
      suites: [
        {
          title: "",
          file: "test/e2e/a.spec.ts",
          specs: [{ title: "browser", tests: [{ results: [{ duration: 20_000 }] }] }],
          suites: [
            {
              title: "platform smoke",
              file: "test/cluster/platform-smoke.spec.ts",
              specs: [
                {
                  title: "provisioning",
                  kind: "cluster",
                  tests: [{ results: [{ duration: 60_000 }] }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(w).toEqual({
      [testKey(e2e("browser"))]: 20,
      [testKey(cluster("provisioning"))]: 60,
    });
  });
});

describe("resolveWeights", () => {
  it("prefers a measured duration over the committed fallback", () => {
    const tests = [e2e("slow")];
    const w = resolveWeights(tests, {
      prior: { [testKey(tests[0])]: 90 },
      committed: { [testKey(tests[0])]: 10 },
    });
    expect(w[testKey(tests[0])]).toBe(90);
  });

  // The sweep repeats the browser specs only, so a shard holding cluster tests is
  // lighter than its e2e weight suggests — packing them as if they scaled too would
  // leave that shard idle while the others run five times as long.
  it("scales the e2e weights by the repeat budget and leaves cluster tests alone", () => {
    const tests = [e2e("browser"), cluster("provisioning")];
    const w = resolveWeights(tests, {
      committed: { [testKey(tests[0])]: 20, [testKey(tests[1])]: 60 },
      repeat: 5,
    });
    expect(w[testKey(tests[0])]).toBe(100);
    expect(w[testKey(tests[1])]).toBe(60);
  });

  it("treats a missing repeat as one pass", () => {
    const tests = [e2e("browser")];
    const w = resolveWeights(tests, { committed: { [testKey(tests[0])]: 20 } });
    expect(w[testKey(tests[0])]).toBe(20);
  });
});

describe("packTests under a sweep", () => {
  it("balances the repeated cost, not the single-pass one", () => {
    const tests = [e2e("heavy"), e2e("light"), cluster("slow-cluster")];
    const committed = {
      [testKey(tests[0])]: 50,
      [testKey(tests[1])]: 50,
      [testKey(tests[2])]: 200,
    };
    // At ×1 the cluster test outweighs both e2e tests and shares a shard with
    // neither; at ×5 each e2e test (250s) outweighs it instead.
    const shards = packTests(tests, resolveWeights(tests, { committed, repeat: 5 }), 2);
    const totals = shards.map((s) => s.total).sort((a, b) => a - b);
    expect(totals).toEqual([250, 450]);
    const withCluster = shards.find((s) => s.tests.some((t) => t.kind === "cluster"));
    expect(withCluster.tests).toHaveLength(2);
  });
});
