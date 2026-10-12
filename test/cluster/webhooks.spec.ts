/**
 * Tier 2: webhooks spawn-from-event end to end on the cluster.
 *
 * POST /webhooks/test makes webhooks spawn a conversation in the agent-host, the fake agent
 * runs in a real sandbox, and the result flows back; the conversation must also appear in
 * the agent-host management API. Gated on RUN_CLUSTER_TESTS=1 and RUN_WEBHOOKS_TESTS=1, with
 * the platform deployed with the test webhook and the fakeAgent agent-host.
 */

import { describe, it, expect, beforeAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const enabled = clusterTestsEnabled() && process.env.RUN_WEBHOOKS_TESTS === "1";
const maybe = enabled ? describe : describe.skip;

const NS = process.env.PLATFORM_NS ?? "agent-sandbox";
const WEBHOOKS = `http://agent-webhooks.${NS}.svc.cluster.local:8080`;
const AGENT_HOST = `http://agent-host.${NS}.svc.cluster.local:8080`;

maybe("webhooks spawn-from-event", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ namespace: NS });
  });

  it("POST /webhooks/test spawns a conversation and returns the agent result", async () => {
    const marker = "wh-spawn-marker";
    const body = await cluster.curlInCluster(`${WEBHOOKS}/webhooks/test`, {
      method: "POST",
      headers: ["Content-Type: application/json"],
      body: JSON.stringify({ task: `!echo ${marker}`, title: "wh-e2e" }),
      timeoutMs: 40_000,
    });

    const resp = JSON.parse(body);
    expect(resp.conversation_id).toBeTruthy();
    expect(resp.result).toContain(marker);

    const listed = await cluster.curlJson(`${AGENT_HOST}/conversations`);
    const ids = (listed as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(resp.conversation_id);
  });
});
