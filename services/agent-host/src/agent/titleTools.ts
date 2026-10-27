/**
 * The set_conversation_title MCP tool, the agent's only way to rename a conversation
 * after its opening `<title>` marker has named it. The marker is accepted once so a
 * revive or BYO reconnect cannot silently retitle a live thread; a deliberate rename
 * comes through here, which forces past that gate but still refuses to overwrite a
 * name the user chose themselves.
 */

import type { ToolResult } from "./mcpServer.js";

/** The longest title worth storing; the sidebar truncates well before this. */
export const MAX_TITLE_LENGTH = 120;

/** What the title tool needs from the agent-host. */
export interface TitleToolsWiring {
  /** This conversation's current title, or undefined when it is unknown here. */
  currentTitle(conversationId: string): string | undefined;
  /** Whether the user named this conversation, in which case the agent must not rename it. */
  userTitled(conversationId: string): boolean | Promise<boolean>;
  /** Rename the conversation, forcing past the name-once gate. */
  setTitle(conversationId: string, title: string): Promise<void>;
}

/** Collapse whitespace and clip to MAX_TITLE_LENGTH, the shape a title is stored in. */
export function normalizeTitle(raw: string): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
}

/** set_conversation_title: rename this conversation, unless the user already named it. */
export async function handleSetConversationTitle(
  deps: TitleToolsWiring,
  conversationId: string,
  args: { title: string },
): Promise<ToolResult> {
  const title = normalizeTitle(args?.title ?? "");
  if (!title) {
    return { isError: true, content: [{ type: "text", text: "title is required and cannot be blank." }] };
  }
  // The user's own name wins: report it rather than failing, so the agent stops retrying.
  if (await deps.userTitled(conversationId)) {
    return {
      content: [
        {
          type: "text",
          text:
            `This conversation was named by the user, so its title is locked and was not changed. ` +
            `Leave it as it is.`,
        },
      ],
    };
  }
  const before = deps.currentTitle(conversationId);
  if (before === title) {
    return { content: [{ type: "text", text: `Already titled "${title}" — no change.` }] };
  }
  await deps.setTitle(conversationId, title);
  return {
    content: [
      {
        type: "text",
        text: before
          ? `Renamed the conversation from "${before}" to "${title}".`
          : `Titled the conversation "${title}".`,
      },
    ],
  };
}
