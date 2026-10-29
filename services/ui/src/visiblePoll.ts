/**
 * Interval polling that runs only while the tab is visible.
 *
 * A backgrounded tab's polls are invisible to the user but not to the server, and a tab
 * left open overnight keeps paying for them. Every repeating poll in the UI goes through
 * here so a hidden tab issues no requests at all, and ticks once on return rather than
 * waiting out the interval with stale data on screen.
 */

/** The visibility source, injected so the poll is testable without a DOM. */
export interface VisibilityHost {
  visible(): boolean;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onChange(cb: () => void): () => void;
}

/** The browser's visibility, treating an environment without `document` as always visible. */
export const documentVisibility: VisibilityHost = {
  visible: () => globalThis.document?.visibilityState !== "hidden",
  onChange(cb) {
    const doc = globalThis.document;
    if (!doc) return () => {};
    doc.addEventListener("visibilitychange", cb);
    return () => doc.removeEventListener("visibilitychange", cb);
  },
};

/**
 * Call `tick` every `intervalMs` while the tab is visible, and once immediately when a
 * hidden tab becomes visible again. Does NOT tick on start, since callers do their own
 * first read. Returns the stop function.
 */
export function pollWhileVisible(
  tick: () => void,
  intervalMs: number,
  host: VisibilityHost = documentVisibility,
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopTimer = () => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  const startTimer = () => {
    if (timer === undefined) timer = setInterval(tick, intervalMs);
  };

  const onChange = () => {
    if (!host.visible()) {
      stopTimer();
      return;
    }
    // Only a tab that was actually stopped owes a catch-up read.
    const wasStopped = timer === undefined;
    startTimer();
    if (wasStopped) tick();
  };

  const off = host.onChange(onChange);
  if (host.visible()) startTimer();

  return () => {
    off();
    stopTimer();
  };
}
