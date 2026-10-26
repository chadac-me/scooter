/**
 * Tier 2: multi-replica platform smoke on a real k3d cluster.
 *
 * With the full platform deployed (agent-host Deployment, conversation-controller,
 * conversation-router, fakeAgent), a conversation posted through the front-door `agent-host`
 * Service must get a `conversations` row assigned a host pod (host_pod) that has a routing
 * address (its pod IP). The workflow deploys the platform before running this; the
 * spec talks to the already-live `agent-sandbox` namespace and is gated on RUN_CLUSTER_TESTS=1.
 */

import { describe, it, expect, beforeAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";
import { waitForConversationRow } from "../support/conversationRow.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;

const NS = process.env.PLATFORM_NS ?? "agent-sandbox";
// The public front door (Service `agent-host`, fronting the router), the same path the UI, broker and webhooks use.
const AGENT_HOST = `http://agent-host.${NS}.svc.cluster.local:8080`;

/** Create a conversation via POST /conversations through the front door and return the server-assigned id. */
async function createConversation(cluster: Cluster): Promise<string> {
  // curlJson tolerates the stray trailing line the curl pod can append after the payload.
  const res = await cluster.curlJson<{ id?: string }>(`${AGENT_HOST}/conversations`, {
    method: "POST",
    headers: ["Content-Type: application/json"],
    body: "{}",
    timeoutMs: 60_000,
  });
  expect(res.id, `POST /conversations returned no id: ${JSON.stringify(res)}`).toBeTruthy();
  return res.id as string;
}

maybe("multi-replica platform smoke", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ namespace: NS });
  });

  it("a conversation routed through the front door is assigned a host pod with an IP", async () => {
    const threadId = await createConversation(cluster);

    // The run only needs to start so the conversation is claimed and its sandbox provisioned.
    const body = await cluster.curlInCluster(`${AGENT_HOST}/agui`, {
      method: "POST",
      headers: ["Content-Type: application/json", "Accept: text/event-stream"],
      body: JSON.stringify({
        threadId,
        runId: "r1",
        messages: [{ id: "m1", role: "user", content: "hello" }],
      }),
      timeoutMs: 60_000,
    });
    // Assert on a terminal event: `kubectl run -i` attaches a few seconds late and can miss the opening RUN_STARTED frame of the SSE stream.
    expect(body, "the front door produced no AG-UI stream at all").toMatch(
      /RUN_FINISHED|RUN_ERROR/,
    );
    // A RUN_ERROR means the path routed but the run failed, which should fail distinctly here.
    expect(body, "the run reached the agent but errored").toContain("RUN_FINISHED");

    // Poll until the row names its owner pod.
    const row = await waitForConversationRow(NS, threadId, (r) => !!r.host_pod && r.phase === "Assigned");
    expect(row.host_generation).toBeGreaterThanOrEqual(1);
    // The router proxies to the owner pod's IP.
    const owner = await cluster.waitFor<{ status?: { podIP?: string } }>(
      "Pod",
      row.host_pod as string,
      (p) => !!p.status?.podIP,
      30_000,
      NS,
    );
    expect(owner.status?.podIP, "the owner pod has a routing IP").toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it("a SHORT-ID-addressed request routes to the OWNER, not a random pod", async () => {
    // The broker addresses approval-notify by the sandbox short-id, and only a multi-replica cluster can show a request landing on a non-owner.
    const threadId = await createConversation(cluster);
    await cluster.curlInCluster(`${AGENT_HOST}/agui`, {
      method: "POST",
      headers: ["Content-Type: application/json", "Accept: text/event-stream"],
      body: JSON.stringify({
        threadId,
        runId: "r1",
        messages: [{ id: "m1", role: "user", content: "short-id routing" }],
      }),
      timeoutMs: 60_000,
    });

    // Wait for assignment so the row carries both the owner and the sandbox the short-id names.
    const row = await waitForConversationRow(NS, threadId, (r) => !!r.host_pod && !!r.sandbox_ref);
    const shortId = (row.sandbox_ref ?? "").replace(/^conv-/, "");
    expect(shortId, "the row must carry a sandbox_ref to derive a short-id from").toMatch(/\S/);

    // Repeated because a misrouted request only fails on the attempts that land on a non-owner.
    for (let attempt = 0; attempt < 5; attempt++) {
      const out = await cluster.curlInCluster(
        `${AGENT_HOST}/conversations/${shortId}/approvals/aws`,
        {
          method: "POST",
          headers: ["Content-Type: application/json"],
          body: JSON.stringify({ request_id: `probe-${attempt}`, message: "routing probe" }),
          timeoutMs: 30_000,
        },
      );
      expect(
        out,
        `attempt ${attempt + 1}: short-id ${shortId} did not reach its owner (routed to a non-owner?)`,
      ).not.toMatch(/not found|unknown conversation/i);
    }
  });

  it("GET /conversations returns EVERY conversation in the fleet, not one pod's slice", async () => {
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) ids.push(await createConversation(cluster));

    for (const threadId of ids) {
      await cluster.curlInCluster(`${AGENT_HOST}/agui`, {
        method: "POST",
        headers: ["Content-Type: application/json", "Accept: text/event-stream"],
        body: JSON.stringify({
          threadId,
          runId: "r1",
          messages: [{ id: "m1", role: "user", content: "fanout" }],
        }),
        timeoutMs: 60_000,
      });
      // Wait for assignment so the controller has spread it before creating the next one.
      await waitForConversationRow(NS, threadId, (r) => !!r.host_pod);
    }

    // The assertion below only has teeth when the conversations span more than one pod.
    const hosts = new Set<string>();
    for (const threadId of ids) {
      const row = await waitForConversationRow(NS, threadId, (r) => !!r.host_pod, 30_000);
      if (row.host_pod) hosts.add(row.host_pod);
    }
    expect(hosts.size, "conversations must span >1 pod for this regression to be meaningful").toBeGreaterThan(1);

    // The front door must list all of them on every call, whichever pod answers.
    for (let attempt = 0; attempt < 5; attempt++) {
      // A read that comes back with no body at all is retried inside curlInCluster.
      const listed = await cluster.curlJson<Array<{ id: string }>>(
        `${AGENT_HOST}/conversations`, { timeoutMs: 30_000 },
      );
      const got = new Set(listed.map((c) => c.id));
      for (const id of ids) {
        expect(got.has(id), `attempt ${attempt + 1}: /conversations omitted ${id} (single-pod view?)`).toBe(true);
      }
    }
  });

  it("a sandbox reaches the broker but not the agent-host (sandbox-isolation NetworkPolicy)", async () => {
    const threadId = await createConversation(cluster);
    await cluster.curlInCluster(`${AGENT_HOST}/agui`, {
      method: "POST",
      headers: ["Content-Type: application/json", "Accept: text/event-stream"],
      body: JSON.stringify({
        threadId,
        runId: "r1",
        messages: [{ id: "m1", role: "user", content: "network isolation" }],
      }),
      timeoutMs: 60_000,
    });
    const row = await waitForConversationRow(NS, threadId, (r) => !!r.sandbox_ref);
    const sandbox = row.sandbox_ref as string;
    await cluster.waitFor<{ status?: { conditions?: Array<{ type: string; status: string }> } }>(
      "Sandbox",
      sandbox,
      (s) => !!s.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
      180_000,
      NS,
    );
    const httpCode = async (url: string) =>
      (
        await cluster.exec(
          `agents.x-k8s.io/sandbox-name=${sandbox}`,
          ["sh", "-c", `curl -s -m 5 -o /dev/null -w '%{http_code}' ${url}`],
          NS,
        )
      ).stdout.trim();

    // The allowed path first, so a sandbox with no network at all cannot pass as "isolated".
    expect(await httpCode(`http://agent-broker.${NS}.svc.cluster.local:8080/health`)).toBe("200");
    // The main listener trusts identity headers, so a sandbox must not get a connection at all.
    expect(await httpCode(`${AGENT_HOST}/whoami`), "sandbox reached the agent-host front door").toBe("000");
    expect(await httpCode(`http://agent-host-pods.${NS}.svc.cluster.local:8080/whoami`), "sandbox reached an agent-host pod").toBe("000");
  }, 300_000);
});
