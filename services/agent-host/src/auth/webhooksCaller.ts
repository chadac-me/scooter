/**
 * Trusted-caller verification for the webhooks and scheduler services. The
 * conversation `owner` on POST /agui is privileged, so it is honored only when the
 * request presents a ServiceAccount token that k8s TokenReview authenticates as one
 * of the configured SAs; anything else leaves the conversation unowned and never
 * blocks the run.
 */

import { Verifier, bearerToken, inClusterReviewer, parseAllowlist } from "@scooter/svcauth";
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

/** Build a verifier that checks the request's Bearer token via TokenReview against the expected SA usernames, or always says "not trusted" when none are configured. */
export function createWebhooksCallerVerifier(config: WebhooksVerifierConfig): WebhooksCallerVerifier {
  const expected = parseAllowlist(config.expectedServiceAccount);
  if (expected.size === 0) return async () => false;
  const custom = config.reviewToken;
  const verifier = new Verifier(
    custom
      ? async (token) => {
          const r = await custom(token, config.audience);
          return { ok: r.authenticated, username: r.username };
        }
      : inClusterReviewer(config.audience ?? ""),
  );
  return async (req) => {
    const token = bearerToken(req.headers);
    if (!token) return false;
    try {
      const { ok, username } = await verifier.verify(token);
      return ok && username !== undefined && expected.has(username);
    } catch {
      // An unreachable TokenReview is treated as untrusted.
      return false;
    }
  };
}
