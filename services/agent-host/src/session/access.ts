/**
 * The per-request visibility check every conversation surface runs: the management API, POST
 * /agui and the web-service proxy. Facts are read fresh from the shared store when there is
 * one, because the router or another replica may have changed them; memory is the fallback for
 * a store-less (single-replica, file-backed) deployment, where this process is the only writer.
 */

import type { IncomingMessage } from "node:http";

import type { UserContext } from "../auth/identity.js";
import { canAccess, type AccessFacts } from "./visibility.js";

export interface AccessCheckDeps {
  /** Fresh owner/visibility from the shared store; throws on a failed read. */
  readAccess?: (id: string) => Promise<AccessFacts | undefined>;
  /** This process's copy, used when the store has no answer. */
  memory: (id: string) => AccessFacts | undefined;
  /** A verified in-cluster service (the webhooks SA) acting for the conversation. */
  trustedService?: (req: IncomingMessage) => Promise<boolean>;
}

/**
 * "allow", "deny", or "unknown" for a conversation neither the store nor memory knows, which
 * the caller leaves to its own not-found handling. Throws when the store read fails, so a
 * caller answers 503 rather than guessing.
 */
export type AccessCheck = (
  id: string,
  req: IncomingMessage,
  user: UserContext | undefined,
) => Promise<"allow" | "deny" | "unknown">;

export function createAccessCheck(deps: AccessCheckDeps): AccessCheck {
  return async (id, req, user) => {
    const facts = (deps.readAccess ? await deps.readAccess(id) : undefined) ?? deps.memory(id);
    if (!facts) return "unknown";
    if (canAccess(facts, user)) return "allow";
    // Checked last: it costs a TokenReview, and only a denied request needs it.
    if (deps.trustedService && (await deps.trustedService(req).catch(() => false))) return "allow";
    return "deny";
  };
}
