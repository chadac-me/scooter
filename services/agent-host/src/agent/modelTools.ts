/**
 * The list_models / switch_model MCP tools, which let the agent see the offered
 * models with their deployment hints and switch its own model mid-conversation.
 * These are pure handlers registered by mcpServer.ts; validation lives here and the
 * manager's switchModelNow does the mechanism.
 */

import type { ModelCatalog } from "./models.js";
import { defaultFor, isOffered } from "./models.js";
import type { ToolResult } from "./mcpServer.js";

/** What the model tools need from the agent-host. */
export interface ModelToolsWiring {
  /** The offered models. */
  catalog: ModelCatalog;
  /** This conversation's current model; undefined means the default. */
  currentModel(conversationId: string): string | undefined;
  /** Who chose the current model; undefined means nobody (the default). */
  modelSetBy?(conversationId: string): "user" | "agent" | undefined;
  /** Switch this conversation's model now and continue on it, resolving to false when already on that model. */
  switchModel(conversationId: string, model: string): Promise<boolean>;
}

function modelLine(id: string, hint: string, current: boolean, isDefault: boolean, setBy?: string): string {
  const picked = current && setBy ? (setBy === "user" ? "picked by the user" : "chosen by you") : null;
  const tags = [current ? "current" : null, picked, isDefault ? "default" : null].filter(Boolean).join(", ");
  const suffix = tags ? `  [${tags}]` : "";
  const h = hint ? ` — ${hint}` : "";
  return `- ${id}${suffix}${h}`;
}

/** list_models: show the offered models, which is current/default, and each hint. */
export function handleListModels(deps: ModelToolsWiring, conversationId: string): ToolResult {
  const { catalog } = deps;
  if (catalog.models.length === 0) {
    return { content: [{ type: "text", text: "No models are configured for selection." }] };
  }
  const current = deps.currentModel(conversationId) ?? defaultFor(catalog, undefined, conversationId);
  const setBy = deps.modelSetBy?.(conversationId);
  const lines = catalog.models.map((m) =>
    modelLine(m.id, m.hint, m.id === current, m.default, setBy),
  );
  // A user's explicit pick outranks the agent's own judgment.
  const keep =
    setBy === "user"
      ? "\nThe user picked your current model: keep it unless they ask you to switch."
      : "";
  return {
    content: [
      {
        type: "text",
        text:
          "Available models (switch with switch_model). Pick the fast/cheap model for simple work; " +
          "escalate to a more powerful one for complex planning, research, or hard debugging:\n" +
          lines.join("\n") +
          keep,
      },
    ],
  };
}

/** switch_model: validate and switch this conversation's model immediately. */
export async function handleSwitchModel(
  deps: ModelToolsWiring,
  conversationId: string,
  args: { model: string },
): Promise<ToolResult> {
  const model = (args.model ?? "").trim();
  const ids = deps.catalog.models.map((m) => m.id);
  if (!model) {
    return { isError: true, content: [{ type: "text", text: `model is required. Available: ${ids.join(", ") || "(none)"}` }] };
  }
  if (!isOffered(deps.catalog, model)) {
    return {
      isError: true,
      content: [{ type: "text", text: `"${model}" is not an available model. Choose one of: ${ids.join(", ") || "(none)"}` }],
    };
  }
  const switched = await deps.switchModel(conversationId, model);
  if (!switched) {
    return { content: [{ type: "text", text: `Already on ${model} — no change.` }] };
  }
  return {
    content: [
      {
        type: "text",
        text:
          `Switched to ${model}. The previous turn was ended to apply the change; I'll continue on the ` +
          `new model — no need to repeat anything.`,
      },
    ],
  };
}
