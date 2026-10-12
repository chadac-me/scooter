/**
 * Theme (light / dark / system): a small useSyncExternalStore store. "light" and "dark"
 * are explicit choices persisted to localStorage; "system" (the default) follows
 * prefers-color-scheme live. The `dark` class on <html> is the single switch every
 * token reads; this module is its only runtime writer, and an inline script in
 * index.html applies the same resolution before first paint, so keep the two in sync.
 */
import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "scooter-theme";

const listeners = new Set<() => void>();

function readStored(): ThemeMode {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // localStorage can throw (private mode / disabled); fall back to system.
  }
  return "system";
}

let mode: ThemeMode = readStored();

const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");

/** Does the current mode resolve to a dark appearance right now? */
function resolvesDark(m: ThemeMode = mode): boolean {
  if (m === "dark") return true;
  if (m === "light") return false;
  return media?.matches ?? false;
}

/** Converge <html>.dark to the resolved appearance; idempotent. */
function apply() {
  globalThis.document?.documentElement.classList.toggle("dark", resolvesDark());
}

function emit() {
  apply();
  for (const cb of listeners) cb();
}

// In system mode an OS appearance change repaints live.
media?.addEventListener?.("change", () => {
  if (mode === "system") emit();
});

// Converge once at import so the store's view is authoritative for later toggles.
apply();

export const themeStore = {
  get(): ThemeMode {
    return mode;
  },
  set(next: ThemeMode) {
    if (next === mode) return;
    mode = next;
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      // Persisting is best-effort; the in-memory mode still drives the UI.
    }
    emit();
  },
  /** Whether the app currently renders dark (resolving "system"). */
  isDark(): boolean {
    return resolvesDark();
  },
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The current mode ("light" | "dark" | "system"). */
export function useTheme(): ThemeMode {
  return useSyncExternalStore(subscribe, () => mode, () => mode);
}
