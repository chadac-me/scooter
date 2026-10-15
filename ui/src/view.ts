/**
 * Top-level view and settings routing: a small useSyncExternalStore store (the app has
 * no router) that also owns the settings path so settings has bookmarkable URLs.
 *
 *   /                     -> chat
 *   /settings             -> settings, first tab
 *   /settings/<tab>       -> settings, that tab
 *
 * Navigation uses history.pushState and listens to popstate so Back/Forward work, and
 * nginx serves the SPA with `try_files $uri $uri/ /index.html` so a hard refresh on a
 * deep link re-derives the tab from the path.
 */

import { useSyncExternalStore } from "react";

export type View = "chat" | "settings";

/** The settings tabs, in sidebar order; `id` is the URL segment. */
export const SETTINGS_TABS = [
  { id: "tasks", label: "Scheduled Tasks" },
  { id: "skills", label: "Skills" },
  { id: "claude", label: "Bring Your Own Claude" },
  { id: "modules", label: "Modules" },
  { id: "admin", label: "Admin Area" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

export const DEFAULT_TAB: SettingsTab = "tasks";

const isTab = (v: string): v is SettingsTab => SETTINGS_TABS.some((t) => t.id === v);

/** Parse a pathname into the view and tab; unknown /settings/<junk> falls back to the default tab. */
export function parsePath(pathname: string): { view: View; tab: SettingsTab } {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "settings") return { view: "chat", tab: DEFAULT_TAB };
  const seg = parts[1] ?? "";
  return { view: "settings", tab: isTab(seg) ? seg : DEFAULT_TAB };
}

/** The URL for a view/tab — the single place paths are constructed. */
export function pathFor(view: View, tab: SettingsTab = DEFAULT_TAB): string {
  return view === "settings" ? `/settings/${tab}` : "/";
}

let state: { view: View; tab: SettingsTab } = parsePath(
  globalThis.location?.pathname ?? "/",
);
let snapshot = state; // stable reference for useSyncExternalStore
const listeners = new Set<() => void>();
const emit = () => {
  snapshot = state;
  listeners.forEach((l) => l());
};

/** Apply a state change and push it to the URL; `replace` skips the history entry. */
function go(next: { view: View; tab: SettingsTab }, replace = false) {
  if (next.view === state.view && next.tab === state.tab) return;
  state = next;
  const url = new URL(globalThis.location.href);
  url.pathname = pathFor(next.view, next.tab);
  // Preserving ?thread= means Back to chat restores the same conversation.
  if (!replace) globalThis.history.pushState(null, "", url);
  emit();
}

export const viewStore = {
  /** Switch the top-level view; settings lands on the default tab. */
  set(v: View) {
    go({ view: v, tab: v === "settings" ? DEFAULT_TAB : state.tab });
  },
  /** Open settings on a specific tab. */
  setTab(tab: SettingsTab) {
    go({ view: "settings", tab });
  },
  get(): View {
    return state.view;
  },
  getTab(): SettingsTab {
    return state.tab;
  },
  /** Re-derive from the current URL — for popstate (Back/Forward). */
  syncFromUrl() {
    const next = parsePath(globalThis.location?.pathname ?? "/");
    if (next.view === state.view && next.tab === state.tab) return;
    state = next;
    emit();
  },
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

// Browser Back/Forward must move between chat and settings tabs.
globalThis.addEventListener?.("popstate", () => viewStore.syncFromUrl());

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useView(): View {
  return useSyncExternalStore(subscribe, () => snapshot.view, () => snapshot.view);
}

export function useSettingsTab(): SettingsTab {
  return useSyncExternalStore(subscribe, () => snapshot.tab, () => snapshot.tab);
}
