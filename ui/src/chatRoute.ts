/**
 * The conversation subpage, `/chat/<conversation-id>`: one conversation's thread, composer and
 * approvals, with no sidebar and no right panel. It is a stable, public route so a sandbox's
 * own page (the marimo wrapper first) can embed the real chat beside its service, and the
 * header's "Pop out chat" opens it in its own window.
 *
 * Embedding is gated by origin, not by anything here: nginx lets `/chat/<id>` be framed only by
 * that conversation's own sandbox origin (`<label>.<sandboxDomain>`) and every other UI route
 * by nothing (pkgs/ui-image/nginx.nix). What this page adds is that it never leaves its one
 * conversation: there is no thread switcher, the selection is pinned (sessionStore.pin), and
 * links open in a new tab rather than inside the host's iframe.
 */

/** The conversation a `/chat/<id>` path names, or undefined for every other path. */
export function chatRouteId(pathname: string): string | undefined {
  const m = /^\/chat\/([^/]+)\/?$/.exec(pathname);
  if (!m) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
  // Conversation ids are UUIDs in practice; anything with a separator or control character
  // is not one and must not reach a request path.
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? id : undefined;
}

/** The subpage URL for a conversation, the single place it is constructed. */
export function chatPath(conversationId: string): string {
  return `/chat/${encodeURIComponent(conversationId)}`;
}

/** The main app's URL for a conversation, for the subpage's "Open in Scooter" link. */
export function appPathFor(conversationId: string): string {
  return `/?thread=${encodeURIComponent(conversationId)}`;
}
