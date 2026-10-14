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
