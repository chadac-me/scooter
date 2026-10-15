import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./globals.css";
// Side-effect import: converge <html>.dark to the stored/OS theme and register the
// prefers-color-scheme listener before the app mounts.
import "./theme.js";
import { App } from "./App.js";
import { viewStore } from "./view.js";
import { currentConversation, sessionStore } from "./sessions.js";
import { loadWhoami } from "./client.js";
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

// The ingress identity: labels conversations "mine" and names the signed-in user in
// the header.
void loadWhoami({ baseUrl: BASE_URL }).then((me) => sessionStore.setCurrentUser(me));

// The conversation list has exactly one source: the stream's `snapshot` on connect, then its
// upsert/remove frames. There is no periodic GET /conversations behind it — a tab opened
// during an agent-host restart paints when the stream connects (it retries until it does),
// and every divergence is repaired by a reconnect, which re-snapshots. Why: PR #780.
// Scope "all"; the Mine/All toggle filters client-side by owner, so it needs no refetch.
subscribeConversations({ baseUrl: BASE_URL }, "all", {
  onSnapshot: (list) => sessionStore.mergeFromServer(list),
  // An upsert carries the row's whole link set, re-read when it was pushed, so it owns its own
  // sources/links — but it says nothing about any other row, so it cannot prune. Why: PR #779.
  onUpsert: (c) => sessionStore.mergeFromServer([c], { fullList: false }),
  onRemove: (id) => sessionStore.removeFromServer(id),
});

// Deep-link support (?thread=<id>): requestSelect's pending target selects the
// conversation once the stream delivers it.
const threadParam = new URLSearchParams(globalThis.location?.search ?? "").get("thread");
if (threadParam) sessionStore.requestSelect(threadParam);
else if (viewStore.get() === "chat") sessionStore.startFresh();

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
