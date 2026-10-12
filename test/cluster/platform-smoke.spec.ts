/**
 * Tier 2: multi-replica platform smoke on a real k3d cluster.
 *
 * With the full platform deployed (agent-host Deployment, conversation-controller,
 * conversation-router, fakeAgent), a conversation posted through the front-door `agent-host`
 * Service must be created as a Conversation CR, assigned a host (status.hostPod) and given a
 * routing address (status.hostIP). The workflow deploys the platform before running this; the
 * spec talks to the already-live `agent-sandbox` namespace and is gated on RUN_CLUSTER_TESTS=1.
 */

import { describe, it, expect, beforeAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;

const NS = process.env.PLATFORM_NS ?? "agent-sandbox";
// The public front door (Service `agent-host`, fronting the router), the same path the UI, broker and webhooks use.
const AGENT_HOST = `http://agent-host.${NS}.svc.cluster.local:8080`;

type ConversationCR = {
  spec?: { sandboxRef?: string };
  status?: { phase?: string; hostPod?: string; hostIP?: string; generation?: number };
};

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

  it("a conversation routed through the front door is assigned a hostPod + hostIP", async () => {
    const threadId = await createConversation(cluster);

    // The run only needs to start so the agent-host registers the Conversation CR.
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

    // Poll until the controller's reconcile has written both the owner name and the routing address.
    const cr = await cluster.waitFor<ConversationCR>(
      "Conversation",
      threadId,
      (c) => !!c.status?.hostPod && !!c.status?.hostIP,
      90_000,
      NS,
    );

    expect(cr.status?.phase).toBe("Assigned");
    expect(cr.status?.hostPod, "controller assigned an owner pod").toBeTruthy();
    // hostIP is the pod IP the router proxies to.
    expect(cr.status?.hostIP, "controller wrote a routing IP").toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(cr.status?.generation ?? 0).toBeGreaterThanOrEqual(1);
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

    // Wait for assignment so the CR carries both ids and a routing address.
    const cr = await cluster.waitFor<ConversationCR>(
      "Conversation",
      threadId,
      (c) => !!c.status?.hostIP && !!c.spec?.sandboxRef,
      90_000,
      NS,
    );
    const shortId = (cr.spec?.sandboxRef ?? "").replace(/^conv-/, "");
    expect(shortId, "the CR must carry a sandboxRef to derive a short-id from").toMatch(/\S/);

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
      await cluster.waitFor<ConversationCR>(
        "Conversation", threadId, (c) => !!c.status?.hostIP, 90_000, NS,
      );
    }

    // The assertion below only has teeth when the conversations span more than one pod.
    const hosts = new Set<string>();
    for (const threadId of ids) {
      const cr = await cluster.waitFor<ConversationCR>(
        "Conversation", threadId, (c) => !!c.status?.hostPod, 30_000, NS,
      );
      if (cr.status?.hostPod) hosts.add(cr.status.hostPod);
    }
    expect(hosts.size, "conversations must span >1 pod for this regression to be meaningful").toBeGreaterThan(1);

    // The front door must list all of them on every call, whichever pod answers.
    for (let attempt = 0; attempt < 5; attempt++) {
      // A read that returns no JSON at all is a transport failure, so retry it a few times before giving up.
      let listed: Array<{ id: string }> | undefined;
      let lastErr: unknown;
      for (let read = 0; read < 5 && !listed; read++) {
        try {
          listed = await cluster.curlJson<Array<{ id: string }>>(
            `${AGENT_HOST}/conversations`, { timeoutMs: 30_000 },
          );
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
      if (!listed) {
        throw new Error(
          `attempt ${attempt + 1}: GET /conversations never returned JSON after 5 reads: ${String(lastErr)}`,
        );
      }
      const got = new Set(listed.map((c) => c.id));
      for (const id of ids) {
        expect(got.has(id), `attempt ${attempt + 1}: /conversations omitted ${id} (single-pod view?)`).toBe(true);
      }
    }
  });
});
