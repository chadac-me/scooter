/**
 * The browser tab title and the header's conversation label, from one rule: the bare
 * wordmark ("scooter") until the selected conversation has a real title, then
 * "scooter - <title>". The placeholder a brand-new chat carries is not a real title,
 * and settings has no conversation at all.
 */

import { DEFAULT_TITLE, sessionStore } from "./sessions.js";
import { viewStore } from "./view.js";

export const APP_NAME = "scooter";

/** A conversation's title when it is a real one, else undefined (empty or the "New chat" placeholder). */
export function displayTitle(title: string | undefined): string | undefined {
  const t = title?.trim();
  return !t || t === DEFAULT_TITLE ? undefined : t;
}

/** The document title for a conversation title. */
export function pageTitle(conversationTitle?: string): string {
  const t = displayTitle(conversationTitle);
  return t ? `${APP_NAME} - ${t}` : APP_NAME;
}

/** The title the current store state calls for; settings shows the bare wordmark. */
export function currentPageTitle(): string {
  if (viewStore.get() === "settings") return APP_NAME;
  const s = sessionStore.get();
  return pageTitle(s.sessions.find((x) => x.id === s.currentId)?.title);
}

/** Keep the tab title in sync with the selected conversation and the view; `tab` defaults to the document and is injectable for the unit tests, which run without a DOM. */
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
