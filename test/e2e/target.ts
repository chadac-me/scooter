/**
 * Which target a spec runs against. The same specs run against two stacks: fast (the
 * default) is the local fake stack, where the browser, the UI and agent-host are real and
 * the agent and sandbox are faked; full is a real cluster (k3d in CI, or a live
 * deployment), the only place the browser meets the real server. full is not a superset
 * of fast (fault-proxy specs only run fast), so the default is "runs on both" and a spec
 * opts out with `fastOnly` / `fullOnly`, which record the reason in the report.
 */
import { test } from "@playwright/test";

/** The target this run drives. Set by the Playwright project, not by a spec. */
export const TARGET: "fast" | "full" = process.env.E2E_TARGET === "full" ? "full" : "fast";

/** True when running against a real cluster / live deployment. */
export const isFull = TARGET === "full";

/** Skip this describe block except on the fast (fake) stack, for specs that need the SSE
 *  fault proxy, a deterministic agent script, or a wipe of all conversations. */
export function fastOnly(reason: string): typeof test.describe {
  return TARGET === "fast" ? test.describe : skipWith(`fast only — ${reason}`);
}

/** Skip this describe block except on the full (real-cluster) target, for stories the fake
 *  stack cannot express. */
export function fullOnly(reason: string): typeof test.describe {
  return TARGET === "full" ? test.describe : skipWith(`full only — ${reason}`);
}

/** A describe that skips, carrying its reason into the report. */
function skipWith(reason: string): typeof test.describe {
  const skipped = ((title: string, body: () => void) =>
    test.describe(title, () => {
      test.skip(true, reason);
      body();
    })) as unknown as typeof test.describe;
  return Object.assign(skipped, test.describe);
}
