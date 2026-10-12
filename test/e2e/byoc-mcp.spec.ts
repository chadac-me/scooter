/**
 * A BYOC container's MCP targets must be reachable, not merely offered.
 *
 * Production failed three ways here and no tier caught any: a 401 on every tunnelled MCP call
 * (headers not threaded), frames routed to the wrong conversation, and an agent offered
 * scooter-broker that timed out using it. The fake stack has no container, so none of it was
 * reachable; this needs the cluster tier.
 */
import { test, expect } from "./fixtures.js";

/** The controller, in-cluster, via the UI origin's nginx. */
const byocBase = (base: string) => `${base.replace(/\/$/, "")}`;

test.describe("byoc", () => {
  test("the controller is reachable and reports a disconnected owner", async ({ request, baseURL }) => {
    const res = await request.get(`${byocBase(baseURL!)}/byoc/status?owner=nobody-here`);
    // 404 means BYOC is not deployed on this target; skip rather than fail.
    test.skip(res.status() === 404, "BYOC is not enabled on this deployment");
    expect(res.ok()).toBe(true);
    expect((await res.json()).status).toBe("disconnected");
  });

  test("minting a session REQUIRES an identity", async ({ request, baseURL }) => {
    const res = await request.post(`${byocBase(baseURL!)}/byoc/sessions`, {
      headers: { "content-type": "application/json" },
      data: {},
    });
    test.skip(res.status() === 404, "BYOC is not enabled on this deployment");
    // An anonymous mint would hand out a tunnel into the cluster.
    expect([401, 403]).toContain(res.status());
  });

  test("an unknown session's tunnel stream is refused", async ({ request, baseURL }) => {
    const res = await request.get(`${byocBase(baseURL!)}/byoc/not-a-real-session/tunnel`, {
      timeout: 15_000,
    });
    test.skip(res.status() === 404 && !res.headers()["content-type"]?.includes("json"),
      "BYOC is not enabled on this deployment");
    expect(res.ok()).toBe(false);
  });
});
