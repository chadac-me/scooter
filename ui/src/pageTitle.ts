/**
 * One rule for the tab title and the header label:
 * "scooter", or "scooter - <title>" once really named.
 */

import { DEFAULT_TITLE, sessionStore } from "./sessions.js";
import { viewStore } from "./view.js";

export const APP_NAME = "scooter";

/** A real title, else undefined (empty or placeholder). */
export function displayTitle(title: string | undefined): string | undefined {
  const t = title?.trim();
  return !t || t === DEFAULT_TITLE ? undefined : t;
}

/** The document title for a conversation title. */
export function pageTitle(conversationTitle?: string): string {
  const t = displayTitle(conversationTitle);
  return t ? `${APP_NAME} - ${t}` : APP_NAME;
}

/** The title for the current state; settings stays bare. */
export function currentPageTitle(): string {
  if (viewStore.get() === "settings") return APP_NAME;
  const s = sessionStore.get();
  return pageTitle(s.sessions.find((x) => x.id === s.currentId)?.title);
}

/** Subscribe the tab title to the selected conversation. `tab` is injectable for DOM-less tests. */
export function installTitleSync(tab: { title: string } | undefined = globalThis.document): () => void {
  if (!tab) return () => {};
  const apply = () => {
    const next = currentPageTitle();
    if (tab.title !== next) tab.title = next;
  };
  apply();
  const offSessions = sessionStore.subscribe(apply);
  const offView = viewStore.subscribe(apply);
  return () => {
    offSessions();
    offView();
  };
}
