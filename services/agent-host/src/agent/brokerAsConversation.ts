/**
 * Broker calls the agent-host makes as one conversation, with no sandbox: its own SA token
 * plus a freshly minted conversation token, the pair the broker accepts from an allowlisted
 * control-plane caller (broker/core/auth.py). Broker hooks and broker skill providers use it,
 * so they work while the conversation's pod is still starting.
 */

import { CONV_TOKEN_HEADER } from "./brokerMcpProxy.js";

export interface BrokerAsConversationDeps {
  /** BROKER_URL, no trailing slash. */
  brokerUrl: string;
  /** The agent-host's SA token headers, re-read per call since the token rotates. */
  authHeaders: () => Promise<Record<string, string>>;
  mintConvToken: (conversationId: string) => string;
  fetch?: typeof fetch;
}

export type BrokerAsConversation = (
  conversationId: string,
  path: string,
  init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; body: string }>;

/** Undefined without a broker URL; a missing token secret fails each call with a clear error. */
export function createBrokerAsConversation(deps: BrokerAsConversationDeps): BrokerAsConversation | undefined {
  if (!deps.brokerUrl) return undefined;
  const doFetch = deps.fetch ?? fetch;
  return async (conversationId, path, init) => {
    const res = await doFetch(`${deps.brokerUrl}/${path.replace(/^\//, "")}`, {
      method: init.method,
      headers: {
        ...(await deps.authHeaders()),
        "Content-Type": "application/json",
        [CONV_TOKEN_HEADER]: deps.mintConvToken(conversationId),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    return { status: res.status, body: await res.text() };
  };
}
