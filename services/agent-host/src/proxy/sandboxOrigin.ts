/**
 * Per-conversation service origins: with a sandbox domain configured, a conversation's web
 * services live at `<scheme>://<label>.<domain>/<service>/`, where <label> is the first 8
 * characters of the conversation id. Without one they stay at `/c/<id>/<service>/` on the
 * main host. The conversation-router resolves the label back to the conversation
 * (services/conversation-router/sandboxhost.go).
 *
 * Two conversations sharing a prefix are refused by the router (409), not resolved; storing
 * a unique label per conversation is a follow-up.
 */

export const SANDBOX_LABEL_LENGTH = 8;

export interface SandboxOrigins {
  /** The parent domain, e.g. "scooter.example.com". */
  domain: string;
  /** "https" or "http", taken from PUBLIC_URL. */
  scheme: string;
}

/** SANDBOX_DOMAIN plus PUBLIC_URL's scheme, or undefined when sandbox origins are off. */
export function sandboxOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxOrigins | undefined {
  const domain = (env.SANDBOX_DOMAIN || "").trim().replace(/\.$/, "").toLowerCase();
  if (!domain) return undefined;
  let scheme = "https";
  try {
    if (env.PUBLIC_URL) scheme = new URL(env.PUBLIC_URL).protocol.replace(/:$/, "");
  } catch {
    // keep https
  }
  return { domain, scheme };
}

/** The host label for a conversation, or undefined when its id can't be one (not hex). */
export function sandboxLabel(threadId: string): string | undefined {
  const label = threadId.slice(0, SANDBOX_LABEL_LENGTH).toLowerCase();
  return /^[0-9a-f]{8}$/.test(label) ? label : undefined;
}

/** The conversation's services origin, e.g. "https://5a515e73.scooter.example.com". */
export function sandboxOrigin(threadId: string, origins: SandboxOrigins | undefined): string | undefined {
  const label = origins ? sandboxLabel(threadId) : undefined;
  return label ? `${origins!.scheme}://${label}.${origins!.domain}` : undefined;
}

/** The path prefix services serve under inside the pod: "" on a sandbox origin, else /c/<id>. */
export function servicePrefix(threadId: string, origins: SandboxOrigins | undefined): string {
  return sandboxOrigin(threadId, origins) ? "" : `/c/${threadId}`;
}

/** Where the browser opens a service: absolute on a sandbox origin, else main-host relative. */
export function serviceUrl(threadId: string, service: string, origins: SandboxOrigins | undefined): string {
  const origin = sandboxOrigin(threadId, origins);
  return origin
    ? `${origin}/${encodeURIComponent(service)}/`
    : `/c/${encodeURIComponent(threadId)}/${encodeURIComponent(service)}/`;
}
