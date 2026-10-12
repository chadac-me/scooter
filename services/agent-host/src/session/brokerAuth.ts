/**
 * Broker auth headers (the agent-host's own projected SA token) for every agent-host ->
 * broker control call; the broker TokenReviews it and authorizes it as a control caller.
 * A missing token (ENOENT) is the local/dev case with no auth header; any other read
 * error is surfaced.
 */

export async function brokerAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const tokenPath = process.env.BROKER_TOKEN_PATH ?? "/var/run/secrets/broker/token";
  try {
    const { readFileSync } = await import("node:fs");
    headers["Authorization"] = `Bearer ${readFileSync(tokenPath, "utf8").trim()}`;
  } catch (e) {
    if ((e as { code?: string })?.code !== "ENOENT") {
      throw new Error(`failed to read broker token at ${tokenPath}: ${(e as Error)?.message ?? e}`, { cause: e });
    }
  }
  return headers;
}
