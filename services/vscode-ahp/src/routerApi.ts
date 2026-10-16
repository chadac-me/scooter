import { readFileSync } from "node:fs";
import type { AguiEvent, ScooterApi } from "./scooterBackend.js";

/** The conversation-router's sandbox self-access API, authenticated as this pod (see conversation-router/selfaccess.go). */
export function routerApi(baseUrl: string, conversationId: string, tokenPath?: string): ScooterApi {
  const base = `${baseUrl.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}`;
  // Re-read per call: the projected token rotates on disk.
  const headers = (): Record<string, string> =>
    tokenPath ? { authorization: `Bearer ${readFileSync(tokenPath, "utf8").trim()}` } : {};
  const post = async (path: string, body?: unknown): Promise<void> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => "")).trim()}`.trim());
  };
  return {
    sendMessage: (text) => post("/messages", { text }),
    cancel: () => post("/cancel"),
    async stream(onEvent, signal) {
      const res = await fetch(`${base}/events`, { headers: { ...headers(), accept: "text/event-stream" }, signal });
      if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
      for await (const data of sseData(res.body as unknown as AsyncIterable<Uint8Array>)) {
        try {
          onEvent(JSON.parse(data) as AguiEvent);
        } catch {
          // A malformed frame is skipped rather than ending the stream.
        }
      }
    },
  };
}

/** Yields the `data:` payload of each SSE frame. */
export async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) yield data;
    }
  }
}
