/**
 * Mobile navigation state: which off-canvas drawer is open on a narrow viewport. Below
 * the `md` breakpoint the two side columns collapse into overlay drawers toggled from
 * the header and the thread takes the full width; desktop (≥1200px) ignores this state
 * because the CSS `desk:` variants pin both panels back in-flow. Same dependency-free
 * useSyncExternalStore store as view.ts.
 */
import { useSyncExternalStore } from "react";

/** Which drawer is open; "none" is the resting state. */
export type Drawer = "none" | "sessions" | "panel";

let drawer: Drawer = "none";
let snapshot: Drawer = drawer; // stable reference for useSyncExternalStore
const listeners = new Set<() => void>();
const emit = () => {
  snapshot = drawer;
  listeners.forEach((l) => l());
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export const mobileNav = {
  /** Open a specific drawer (replaces any other that was open). */
  open(d: Exclude<Drawer, "none">) {
    if (drawer !== d) {
      drawer = d;
      emit();
    }
  },
  /** Open a drawer, or close it if it is already the open one. */
  toggle(d: Exclude<Drawer, "none">) {
    drawer = drawer === d ? "none" : d;
    emit();
  },
  /** Close whatever drawer is open (no-op if already closed). */
  close() {
    if (drawer !== "none") {
      drawer = "none";
      emit();
    }
  },
  get(): Drawer {
    return drawer;
  },
  subscribe,
};

/** Reactively read which drawer is open. */
export function useDrawer(): Drawer {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

// 1199.98 matches the CSS `desk:` cutover (--breakpoint-desk in globals.css) exactly, so drawer behavior and panel visibility agree at the boundary.
const MOBILE_QUERY = "(max-width: 1199.98px)";

/** True on viewports below the desk breakpoint; re-renders on viewport change. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = globalThis.matchMedia?.(MOBILE_QUERY);
      if (!mq) return () => {};
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => globalThis.matchMedia?.(MOBILE_QUERY).matches ?? false,
    () => false, // no matchMedia (SSR/tests): assume desktop
  );
}
