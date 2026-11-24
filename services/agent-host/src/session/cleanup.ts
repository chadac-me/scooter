/**
 * One-shot conversations: what to delete once a run finishes. "conversation" deletes all of it
 * (row, event log, Sandbox, volumes); "sandbox" deletes the Sandbox and its volumes and keeps the
 * transcript, so a later prompt starts on a fresh sandbox.
 */

export type CleanupMode = "conversation" | "sandbox";

export function isCleanupMode(v: unknown): v is CleanupMode {
  return v === "conversation" || v === "sandbox";
}
