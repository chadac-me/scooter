import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./globals.css";
// Side-effect import: converge <html>.dark to the stored/OS theme and register the
// prefers-color-scheme listener before the app mounts.
import "./theme.js";
import { App } from "./App.js";
import { viewStore } from "./view.js";
import { currentConversation, sessionStore } from "./sessions.js";
import { loadConversations, loadConversationsResult, loadWhoami } from "./client.js";
import { subscribeConversations } from "./conversationStream.js";
import { initTelemetryFromServer, installGlobalErrorHandlers } from "./telemetry.js";
import { loadContribManifest } from "./contribManifest.js";
import { installTitleSync } from "./pageTitle.js";

// Telemetry is configured at runtime from nginx's /telemetry/config.json, so the first
// requests of a page load go untraced while that fetch is in flight; the error handlers
// install synchronously and are not gated on it.
void initTelemetryFromServer();
installGlobalErrorHandlers();

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

// Load all conversations; the Mine/All toggle filters client-side by owner, so
// toggling needs no refetch.
const refreshConversations = () =>
  void loadConversations({ baseUrl: BASE_URL }, "all").then((convs) => {
    sessionStore.mergeFromServer(convs);
  });

// The ingress identity: labels conversations "mine" and names the signed-in user in
// the header.
void loadWhoami({ baseUrl: BASE_URL }).then((me) => sessionStore.setCurrentUser(me));

// The initial load retries with backoff so a tab opened during an agent-host restart
// paints the sidebar as soon as it is back rather than on the 10s poll.
const initialLoad = async () => {
  for (let delay = 500; delay <= 8000; delay *= 2) {
    const { ok, conversations } = await loadConversationsResult({ baseUrl: BASE_URL }, "all");
    if (ok) {
      sessionStore.mergeFromServer(conversations);
      return;
    }
    await new Promise((r) => setTimeout(r, delay));
  }
};
void initialLoad();
setInterval(refreshConversations, 10000);

// Live sidebar push: the conversation-list stream folds through the same
// mergeFromServer as the poll, with scope "all" to match it, and the poll stays as
// the backstop.
subscribeConversations({ baseUrl: BASE_URL }, "all", {
  onSnapshot: (list) => sessionStore.mergeFromServer(list),
  // A single-row upsert is not authoritative for sources/links, so an empty `sources: []`
  // must not clobber the poll-populated provider icon.
  onUpsert: (c) => sessionStore.mergeFromServer([c], { sourcesAuthoritative: false }),
});

// ?thread=<id> selects that conversation once the poll delivers it.
// A bare chat URL opens a fresh conversation instead. Reloads still
// restore, because the subscriber below writes ?thread= back.
const threadParam = new URLSearchParams(globalThis.location?.search ?? "").get("thread");
if (threadParam) sessionStore.requestSelect(threadParam);
else if (viewStore.get() === "chat") sessionStore.startFresh();

// Tab title: "scooter", then "scooter - <title>".
installTitleSync();

// Reflect the selected conversation in the URL via replaceState, but never while on a
// /settings/<tab> path, where it would rewrite the settings URL.
sessionStore.subscribe(() => {
  if (viewStore.get() === "settings") return;
  // Reflect the server's id, never the local key `currentId`, which the server would
  // 404; before it arrives there is nothing to reflect.
  const id = currentConversation()?.serverId();
  if (id === undefined) return;
  const url = new URL(globalThis.location.href);
  if (url.searchParams.get("thread") !== id) {
    url.searchParams.set("thread", id);
    globalThis.history.replaceState(null, "", url);
  }
});

// The contrib manifest decides what renders (labels, icons, filter chips), so the first
// paint waits for it; the loader's 1.5s timeout degrades a missing manifest to the
// built-in sources rather than a blank page.
void loadContribManifest().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
