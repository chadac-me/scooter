/**
 * The supported surface for contrib UI code (contrib/<name>/ui/*.tsx: settings tabs
 * and interrupt renderers). Such a module may import only from here, @/components/*,
 * @/lib/* and ui/package.json deps; the ESLint rule in ui/eslint.config.js enforces it.
 * Anything a module needs from the app belongs here, so
 * the app's internals can change without breaking contribs.
 */

import { useCurrentUser } from "../sessions.js";

export { Button } from "@/components/ui/button";
export { Spinner } from "@/components/ui/spinner";
export { EmptyState } from "@/components/ui/empty-state";
export { ErrorState } from "@/components/ui/error-state";
export { cn } from "@/lib/utils";

/** The signed-in caller, as the header badge shows it. */
export interface Whoami {
  id: string;
  email: string | null;
  anonymous: boolean;
}

/** The signed-in caller from /whoami. */
export function useWhoami(): Whoami {
  return useCurrentUser();
}

/** Class strings for form controls, matching the built-in settings tabs. */
export const inputClass = "rounded-md border border-input bg-background px-2 py-1.5 text-sm";
export const monoInputClass = "rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm";
export const textareaClass =
  "min-h-24 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

/**
 * Call this contrib's broker routes as the signed-in user. Needs `api = true` on the
 * tab's `ui.settingsTabs` row. `contribFetch("echo", "whoami")` reaches the broker's
 * `/echo/user/whoami`; the agent-host names the user, so the route never trusts
 * anything the tab sends about who it is. A plain `fetch` Response comes back: 401
 * when signed out, 404 when the contrib has no relay, and otherwise the route's own
 * status. A JSON body is sent with its content type when `init.json` is set.
 */
export function contribFetch(
  contrib: string,
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  const url = `${BASE_URL}/contrib-api/${encodeURIComponent(contrib)}/${path.replace(/^\/+/, "")}`;
  return fetch(url, {
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: "same-origin",
  });
}

/** What an interrupt renderer (a contrib's `ui.interruptRenderers` entry) receives for one pending request. */
export interface InterruptRendererProps {
  /** The request's heading. */
  message: string;
  /** The request's data as the agent sent it, unvalidated: the renderer checks its own shape and throws on one it cannot draw. */
  data: unknown;
  /** True while an answer is being sent. */
  busy: boolean;
  /** Answer with a JSON object, which the agent receives as the request's result. */
  resolve(result: Record<string, unknown>): void;
  /** Dismiss without answering; the agent is told the user did not answer. */
  dismiss(): void;
}
