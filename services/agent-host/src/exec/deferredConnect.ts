/**
 * Lazy connect with in-flight dedupe: the sandbox exec client connects on first use
 * (a pod-readiness poll of up to ~90s), so a burst of concurrent first tool calls
 * must share one connect. The promise itself is memoized, and cleared on failure so
 * a transient error does not permanently wedge the conversation.
 */

export function createDeferredConnector<T>(connect: () => Promise<T>): () => Promise<T> {
  let resolved: T | undefined;
  let pending: Promise<T> | undefined;

  return async function ensure(): Promise<T> {
    if (resolved !== undefined) return resolved;
    if (pending) return pending;
    pending = (async () => {
      try {
        const value = await connect();
        resolved = value;
        return value;
      } finally {
        // On success `resolved` now short-circuits; on failure the next call retries.
        pending = undefined;
      }
    })();
    return pending;
  };
}

/**
 * createDeferredConnector, but dropped and re-made whenever `epoch()` changes: a pod stopped or
 * cycled under a live bridge bumps the epoch, so the next call reconnects (resolving the pod
 * afresh, and resuming a stopped one) instead of reusing a client bound to the old pod.
 */
export function createEpochConnector<T>(connect: () => Promise<T>, epoch: () => number): () => Promise<T> {
  let seen = epoch();
  let ensure = createDeferredConnector(connect);
  return () => {
    const now = epoch();
    if (now !== seen) {
      seen = now;
      ensure = createDeferredConnector(connect);
    }
    return ensure();
  };
}

/** Per-Sandbox connection generations, keyed namespace/name. */
const sandboxEpochs = new Map<string, number>();
const epochKey = (ref: { namespace: string; name: string }) => `${ref.namespace}/${ref.name}`;

/** The Sandbox's current connection generation. */
export function sandboxEpoch(ref: { namespace: string; name: string }): number {
  return sandboxEpochs.get(epochKey(ref)) ?? 0;
}

/** Invalidate every cached connection to the Sandbox's pod; call after stopping or cycling it. */
export function bumpSandboxEpoch(ref: { namespace: string; name: string }): void {
  sandboxEpochs.set(epochKey(ref), sandboxEpoch(ref) + 1);
}
