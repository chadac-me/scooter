/**
 * Reconnect backoff for the container's cloud connection, kept socket-free so it is
 * testable. Every container in the fleet reconnects to a single-replica controller after
 * a rollout, so the backoff is exponential with jitter to break the lockstep, and capped
 * so recovery stays prompt after a long outage.
 */

/** First retry, fast so a rollout does not feel like an outage. */
export const RECONNECT_BASE_MS = 1_000;
/** Ceiling, long enough to stop hammering and short enough to recover promptly. */
export const RECONNECT_CAP_MS = 30_000;

/** Delay before reconnect attempt `attempt` (1-based): a random point in [half, full] of the capped exponential window, with `rand` injectable for tests. */
export function nextReconnectDelay(attempt: number, rand: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  // Cap the exponent before the multiply so a large attempt count cannot overflow to Infinity.
  const exponent = Math.min(n - 1, 32);
  // One cap, applied to the window before jitter, so the result is always in (0, CAP].
  const window = Math.min(RECONNECT_BASE_MS * 2 ** exponent, RECONNECT_CAP_MS);
  const jittered = window * (0.5 + 0.5 * Math.min(Math.max(rand(), 0), 1));
  return Math.max(1, Math.round(jittered));
}

// --- Close-code interpretation (why did the cloud hang up?) ---------------------------------
//
// The controller closes with an application code and reason for conditions the container
// should react to differently than a network blip.

/** The controller rejected this connection's credentials. */
export const CLOSE_AUTH_REJECTED = 4001;
/** Another container for the same owner connected and superseded this one. */
export const CLOSE_SUPERSEDED = 4002;

/** Retry cadence for a rejected authentication, slow because a human has to fetch a fresh command but still recovering unattended once the server side is fixed. */
export const AUTH_RETRY_MS = 5 * 60_000;
/** Retry cadence after being superseded, slow enough that two containers for one owner do not ping-pong and fast enough to take over when the other stops. */
export const SUPERSEDED_RETRY_MS = 60_000;

export interface CloseDisposition {
  /** What the container should tell its human, or null for the generic "disconnected (code N)" line. */
  message: string | null;
  delayMs: number;
}

/** Decide the log line and retry delay for a server close. */
export function closeDisposition(
  code: number,
  reason: string,
  attempt: number,
  rand: () => number = Math.random,
): CloseDisposition {
  if (code === CLOSE_AUTH_REJECTED) {
    return {
      message:
        `AUTHENTICATION FAILED: ${reason || "the server rejected this container's credentials"}. ` +
        `Retrying every ${AUTH_RETRY_MS / 60000} min, but this will not fix itself — ` +
        `get a fresh docker command from the Settings page.`,
      delayMs: AUTH_RETRY_MS,
    };
  }
  if (code === CLOSE_SUPERSEDED) {
    return {
      message:
        `superseded: ${reason || "another container connected for this account"} — ` +
        `this one is standing by (stop one of them to avoid confusion).`,
      delayMs: SUPERSEDED_RETRY_MS,
    };
  }
  return { message: null, delayMs: nextReconnectDelay(attempt, rand) };
}
