/**
 * Parsing a permission answer that came back from the cloud. This is a security boundary
 * that decides whether the user approved a tool call, so it accepts both the flat shape
 * and the nested one (the container does not redeploy in lockstep with the cloud) and
 * fails closed: anything unrecognised is a cancellation.
 */

/** What the local SDK expects back from its permission handler. */
export type PermissionAnswer = { optionId: string; result?: Record<string, unknown> } | { cancelled: true };

const CANCELLED: PermissionAnswer = { cancelled: true };

export function parsePermissionAnswer(payload: unknown): PermissionAnswer {
  if (!payload || typeof payload !== "object") return CANCELLED;
  const p = payload as Record<string, unknown>;

  // An error means the controller could not deliver the decision, which is never an approval.
  if (typeof p.error === "string") return CANCELLED;

  // The nested shape {result: {...}} is unwrapped once, then the same rules apply; a flat answer
  // has its own optionId, and its `result` is a contrib request's answer, not a wrapper.
  const nested = typeof p.optionId !== "string" && p.result && typeof p.result === "object";
  const body = nested ? (p.result as Record<string, unknown>) : p;

  if (body.cancelled === true) return CANCELLED;
  // A non-empty string is the only thing that counts as a real selection.
  if (typeof body.optionId === "string" && body.optionId.length > 0) {
    const result = objectOf(body.result);
    return result ? { optionId: body.optionId, result } : { optionId: body.optionId };
  }
  return CANCELLED;
}

/** `v` when it is a plain object (a contrib request's result), else undefined. */
function objectOf(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
