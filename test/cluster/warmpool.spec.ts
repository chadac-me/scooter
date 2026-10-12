/**
 * Tier 2: the generic warm-pool fast path, proving a claim from a warm pool is materially
 * faster than a cold start. Warm pools are not implemented yet, so this is additionally
 * gated on RUN_WARMPOOL_TESTS=1.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const enabled = clusterTestsEnabled() && process.env.RUN_WARMPOOL_TESTS === "1";
const maybe = enabled ? describe : describe.skip;

maybe("warm-pool fast path", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ installController: true, namespace: "agent-sandbox-test" });
    await cluster.apply({ __warmPool: { name: "generic", replicas: 2 } });
    await cluster.waitFor("SandboxWarmPool", "generic", (p: any) => (p.status?.availableReplicas ?? 0) >= 1, 180_000);
  });

  it("claims a warm sandbox within the fast-path latency budget", async () => {
    const t0 = Date.now();
    await cluster.apply({ __claim: { name: "claim-1", warmPool: "generic" } });
    await cluster.waitFor("SandboxClaim", "claim-1", (c: any) => !!c.status?.assignedSandboxName, 60_000);
    const elapsed = Date.now() - t0;

    // A warm claim must beat a cold start comfortably.
    expect(elapsed).toBeLessThan(15_000);
  });
});
