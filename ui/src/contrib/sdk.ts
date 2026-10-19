/**
 * The supported surface for contrib settings-tab code (contrib/<name>/ui/*.tsx). A tab
 * may import only from here, @/components/*, @/lib/* and ui/package.json deps; the
 * ESLint rule in ui/eslint.config.js enforces it. Anything a tab needs from the app
 * belongs here, so the app's internals can change without breaking contribs.
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
