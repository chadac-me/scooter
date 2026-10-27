/**
 * Broker auth headers (the agent-host's own projected SA token) for every agent-host ->
 * broker control call; the broker TokenReviews it and authorizes it as a control caller.
 * A missing token is the local/dev case with no auth header; any other read error is
 * surfaced.
 */

import { TokenSource } from "@scooter/svcauth";

let source: TokenSource | undefined;

export async function brokerAuthHeaders(): Promise<Record<string, string>> {
  const path = process.env.BROKER_TOKEN_PATH ?? "/var/run/secrets/broker/token";
  if (source?.path !== path) source = new TokenSource(path);
  const token = source.current();
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
