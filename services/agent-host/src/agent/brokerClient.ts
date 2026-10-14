/**
 * The agent-host's server-side broker client. A `BrokerClient.call` issues one
 * authenticated request to the broker and returns the raw upstream outcome so
 * callers can echo errors verbatim. Auth is a Bearer token read per call from
 * `BROKER_TOKEN_PATH` (the agent-host's ServiceAccount token); a missing token is
 * the local/dev case, while an unreadable one is thrown rather than silently
 * downgraded to an unauthenticated call.
 */

/** A broker HTTP call that returns the raw upstream outcome so the caller can echo errors faithfully. */
export interface BrokerClient {
  call(
    conversationId: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<BrokerResponse>;
}

export interface BrokerResponse {
  /** HTTP status from the broker/upstream. */
  status: number;
  /** Parsed JSON body when the response was JSON; else undefined. */
  data?: unknown;
  /** Raw text body, always present, carrying the verbatim upstream error on failure. */
  raw: string;
}

export interface HttpBrokerClientDeps {
  /** The broker base URL, normalized here. */
  baseUrl: string;
  /** Path to the agent-host's SA token, read per call; unset means no auth header. */
  tokenPath?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

/** An HTTP-backed BrokerClient bound to the agent-host's broker identity. */
export function createBrokerClient(deps: HttpBrokerClientDeps): BrokerClient {
  const base = deps.baseUrl.replace(/\/$/, "");
  const doFetch = deps.fetchImpl ?? fetch;
  const tokenPath = deps.tokenPath;

  async function authHeader(): Promise<Record<string, string>> {
    if (!tokenPath) return {};
    try {
      const { readFileSync } = await import("node:fs");
      return { Authorization: `Bearer ${readFileSync(tokenPath, "utf8").trim()}` };
    } catch (e) {
      // Only a not-found token is the dev case; an unreadable one must not silently
      // downgrade to an unauthenticated call.
      if ((e as { code?: string })?.code !== "ENOENT") {
        throw new Error(
          `failed to read broker token at ${tokenPath} (would send an ` +
            `unauthenticated broker request): ${(e as Error)?.message ?? e}`,
          { cause: e },
        );
      }
      return {}; /* no token (local/dev) */
    }
  }

  return {
    async call(_conversationId, method, path, body): Promise<BrokerResponse> {
      // The broker trusts the SA token, so the conversationId is not sent.
      const headers: Record<string, string> = { ...(await authHeader()) };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await res.text().catch(() => "");
      let data: unknown;
      // Parse JSON when possible; `raw` still carries the verbatim body either way.
      try {
        data = raw ? JSON.parse(raw) : undefined;
      } catch {
        data = undefined;
      }
      return { status: res.status, data, raw };
    },
  };
}
