/**
 * The make_conversation_private MCP tool. It only ever narrows access: an agent may take a
 * shared conversation private so the broker vends its owner's personal credentials, but
 * going back to shared stays an owner-only action in the UI (PATCH /visibility).
 */

import type { ToolResult } from "./mcpServer.js";
import type { Visibility } from "../session/visibility.js";

/** What the visibility tool needs from the agent-host. */
export interface VisibilityToolsWiring {
  /** The top-level conversation `id` runs under (itself unless a subagent), undefined if unknown. */
  rootOf(conversationId: string): string | undefined;
  /** The root's owner, undefined when it has none. */
  owner(rootId: string): string | undefined;
  /** The root's visibility as the shared store has it now. */
  currentVisibility(rootId: string): Promise<Visibility>;
  /** Make the root, and with it every subagent, private. */
  makePrivate(rootId: string): Promise<void>;
}

const text = (t: string, isError = false): ToolResult => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text", text: t }],
});

/** make_conversation_private: shared → private, never the reverse. */
export async function handleMakeConversationPrivate(
  deps: VisibilityToolsWiring,
  conversationId: string,
): Promise<ToolResult> {
  const root = deps.rootOf(conversationId);
  if (!root) return text("This conversation is not known here, so its visibility was not changed.", true);
  // No owner means nobody the private conversation could admit.
  if (!deps.owner(root)) {
    return text("This conversation has no owner, so it cannot be made private. Tell the user.", true);
  }
  if ((await deps.currentVisibility(root)) === "private") {
    return text("This conversation is already private; no change.");
  }
  await deps.makePrivate(root);
  return text(
    "This conversation is now private: only its owner can see or prompt it, and within a few " +
      "seconds the sandbox acts as them (their SSH key and commit identity). Only the owner can " +
      "make it shared again, from the UI.",
  );
}
