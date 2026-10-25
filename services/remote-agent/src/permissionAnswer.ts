/**
 * Parsing a permission answer that came back from the cloud. This is a security boundary
 * that decides whether the user approved a tool call, so it accepts both the flat shape
 * and the nested one (the container does not redeploy in lockstep with the cloud) and
 * fails closed: anything unrecognised is a cancellation.
 */

/** What the local SDK expects back from its permission handler. */
export type PermissionAnswer = { optionId: string; answers?: Record<string, string> } | { cancelled: true };

const CANCELLED: PermissionAnswer = { cancelled: true };

export function parsePermissionAnswer(payload: unknown): PermissionAnswer {
  if (!payload || typeof payload !== "object") return CANCELLED;
  const p = payload as Record<string, unknown>;

  // An error means the controller could not deliver the decision, which is never an approval.
  if (typeof p.error === "string") return CANCELLED;

  // The nested shape {result: {...}} is unwrapped once, then the same rules apply.
  const body = (p.result && typeof p.result === "object" ? (p.result as Record<string, unknown>) : p);

  if (body.cancelled === true) return CANCELLED;
  // A non-empty string is the only thing that counts as a real selection.
  if (typeof body.optionId === "string" && body.optionId.length > 0) {
    const answers = stringRecord(body.answers);
    return answers ? { optionId: body.optionId, answers } : { optionId: body.optionId };
  }
  return CANCELLED;
}

/** The answers map with every non-string value dropped, or undefined when there is none. */
function stringRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out = Object.fromEntries(Object.entries(v).filter(([, a]) => typeof a === "string")) as Record<string, string>;
  return Object.keys(out).length > 0 ? out : undefined;
}
