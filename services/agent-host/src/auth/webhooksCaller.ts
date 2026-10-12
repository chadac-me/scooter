/**
 * Trusted-caller verification for the webhooks and scheduler services. The
 * conversation `owner` on POST /agui is privileged, so it is honored only when the
 * request presents a ServiceAccount token that k8s TokenReview authenticates as one
 * of the configured SAs; anything else leaves the conversation unowned and never
 * blocks the run.
 */

import { KubeConfig, AuthenticationV1Api } from "@kubernetes/client-node";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";

/** Verifies whether a request is the trusted webhooks caller. */
export type WebhooksCallerVerifier = (req: IncomingMessage) => Promise<boolean>;

export interface WebhooksVerifierConfig {
  /** The comma-separated trusted SA usernames that may set `owner`, e.g. `system:serviceaccount:agent-sandbox:agent-webhooks`; empty disables verification. */
  expectedServiceAccount?: string;
  /** The token audience the SA token is projected for. */
  audience?: string;
  /** Injectable TokenReview for tests. */
  reviewToken?: (token: string, audience?: string) => Promise<{ authenticated: boolean; username?: string }>;
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  const v = Array.isArray(h) ? h[0] : h;
  if (!v || !/^bearer /i.test(v)) return undefined;
  return v.slice(7).trim() || undefined;
}

function defaultReviewToken(): (token: string, audience?: string) => Promise<{ authenticated: boolean; username?: string }> {
  let api: AuthenticationV1Api | undefined;
  const client = (): AuthenticationV1Api => {
    if (!api) {
      const kc = new KubeConfig();
      if (existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token")) kc.loadFromCluster();
      else kc.loadFromDefault();
      api = kc.makeApiClient(AuthenticationV1Api);
    }
    return api;
  };
  return async (token, audience) => {
    const res = await client().createTokenReview({
      body: {
        apiVersion: "authentication.k8s.io/v1",
        kind: "TokenReview",
        spec: { token, ...(audience ? { audiences: [audience] } : {}) },
      },
    });
    const status = res.status;
    return { authenticated: status?.authenticated === true, username: status?.user?.username };
  };
}

/** Build a verifier that checks the request's Bearer token via TokenReview against the expected SA usernames, or always says "not trusted" when none are configured. */
export function createWebhooksCallerVerifier(config: WebhooksVerifierConfig): WebhooksCallerVerifier {
  const expected = new Set(
    (config.expectedServiceAccount ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (expected.size === 0) return async () => false;
  const review = config.reviewToken ?? defaultReviewToken();
  return async (req) => {
    const token = bearer(req);
    if (!token) return false;
    try {
      const { authenticated, username } = await review(token, config.audience);
      return authenticated && username !== undefined && expected.has(username);
    } catch {
      // An unreachable TokenReview is treated as untrusted.
      return false;
    }
  };
}
