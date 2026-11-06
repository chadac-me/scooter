// The conversation state stream and the contrib publish route.

import type { IncomingMessage } from "node:http";

import type { Router } from "../http/router.js";
import type { StateFrame, StateHub } from "../session/stateHub.js";

// Manifest-style names only, so a topic cannot smuggle a separator.
const CONTRIB_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Bigger values belong behind the contrib's own GET route.
const MAX_CONTRIB_DATA_BYTES = 64 * 1024;

export interface StateStreamDeps {
  hub: StateHub;
  /** Conversation id or sandbox key to conversation id, hydrating if absent. */
  resolve(id: string): Promise<string | null>;
  fromService(req: IncomingMessage): Promise<boolean>;
  streamOwnership?: (id: string) => Promise<"mine" | "elsewhere" | "unknown">;
}

export function mountStateStream(r: Router, deps: StateStreamDeps): void {
  r.get("/conversations/:id/state/events", async (ctx) => {
    const id = await deps.resolve(ctx.params.id);
    const { res } = ctx;
    if (!id) {
      res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    const send = (frame: StateFrame) => {
      try {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      } catch {
        // Socket gone; the close handler unsubscribes.
      }
    };
    const unsub = deps.hub.subscribe(id, send);

    // Producers run on the owner, so reconnect through the router.
    const closeIfElsewhere = async () => {
      const where = await deps.streamOwnership?.(id).catch(() => "unknown" as const);
      if (where !== "elsewhere") return;
      try {
        res.write(": owner-elsewhere — reconnect\n\n");
      } catch {
        // Already closing.
      }
      res.end();
    };
    void closeIfElsewhere();
    const ownership = setInterval(() => void closeIfElsewhere(), 5_000);
    // Keeps proxy read timeouts from dropping a quiet stream.
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // Connection closed.
      }
    }, 25_000);
    ownership.unref?.();
    heartbeat.unref?.();

    ctx.req.on("close", () => {
      clearInterval(ownership);
      clearInterval(heartbeat);
      unsub();
    });
  });

  // Body `{data?}`: data is pushed as-is, absent means subscribers refetch.
  r.post("/conversations/:id/state/contrib/:contrib", async (ctx) => {
    if (!(await deps.fromService(ctx.req))) {
      return { status: 403, json: { error: "only a platform service may call this" } };
    }
    const contrib = ctx.params.contrib;
    if (!CONTRIB_NAME.test(contrib)) return { status: 400, json: { error: "invalid contrib name" } };
    const body = await ctx.body<{ data?: unknown } | null>().catch(() => null);
    const data = body && typeof body === "object" ? body.data : undefined;
    if (data !== undefined && JSON.stringify(data).length > MAX_CONTRIB_DATA_BYTES) {
      return { status: 413, json: { error: "data too large; publish without data and let the UI refetch" } };
    }
    const id = await deps.resolve(ctx.params.id);
    if (!id) return { status: 404, json: { error: "unknown conversation" } };
    // useContribTopic reads the same name.
    deps.hub.publish(id, `contrib:${contrib}`, data);
    return { status: 202, json: { ok: true } };
  });
}
