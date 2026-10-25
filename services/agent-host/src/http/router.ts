/**
 * Tiny method+path router over node:http. Routes use `:param` segments and an optional trailing `*`; a handler
 * gets parsed params and a lazy JSON body, and returns a JsonResult to send JSON or
 * handles the response itself (e.g. SSE) and returns undefined.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  resolverFromEnv,
  type UserContext,
} from "../auth/identity.js";
import { withConversation } from "../log.js";

/** How the router resolves the caller's identity per request, defaulting to the env-configured resolver with no store. */
export type ResolveUser = (req: IncomingMessage) => Promise<UserContext> | UserContext;

function defaultResolveUser(): ResolveUser {
  const resolver = resolverFromEnv();
  return (req) => resolver.resolve(req);
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: <T = unknown>() => Promise<T>;
  /** The caller's identity from the trusted ingress, or anonymous when none. */
  user: UserContext;
}

export type JsonResult = { status?: number; json: unknown };
export type Handler = (ctx: Ctx) => Promise<JsonResult | void> | JsonResult | void;
/** Runs before a matched handler; a result short-circuits it. */
export type Guard = (ctx: Ctx) => Promise<JsonResult | undefined> | JsonResult | undefined;

interface Route {
  method: string;
  segments: string[]; // e.g. ["conversations", ":id", "suspend"]
  handler: Handler;
}

export interface Router {
  on(method: string, path: string, handler: Handler): Router;
  get(path: string, handler: Handler): Router;
  post(path: string, handler: Handler): Router;
  patch(path: string, handler: Handler): Router;
  del(path: string, handler: Handler): Router;
  /** Add a guard run before every matched handler, in registration order. */
  guard(g: Guard): Router;
  /** Returns true if a route matched and was dispatched. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export function createRouter(resolveUser: ResolveUser = defaultResolveUser()): Router {
  const routes: Route[] = [];
  const guards: Guard[] = [];

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

  const match = (route: Route, parts: string[]): Record<string, string> | null => {
    // A trailing `*` segment matches one or more remaining segments, kept encoded and
    // joined as params["*"], so a relay can forward the rest of the path verbatim.
    const rest = route.segments[route.segments.length - 1] === "*";
    const fixed = rest ? route.segments.length - 1 : route.segments.length;
    if (rest ? parts.length <= fixed : parts.length !== fixed) return null;
    const params: Record<string, string> = {};
    if (rest) params["*"] = parts.slice(fixed).join("/");
    for (let i = 0; i < fixed; i++) {
      const seg = route.segments[i];
      if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) return null;
    }
    return params;
  };

  const router: Router = {
    on(method, path, handler) {
      routes.push({
        method: method.toUpperCase(),
        segments: path.split("/").filter(Boolean),
        handler,
      });
      return router;
    },
    get(path, handler) {
      return router.on("GET", path, handler);
    },
    post(path, handler) {
      return router.on("POST", path, handler);
    },
    patch(path, handler) {
      return router.on("PATCH", path, handler);
    },
    del(path, handler) {
      return router.on("DELETE", path, handler);
    },
    guard(g) {
      guards.push(g);
      return router;
    },

    async handle(req, res) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      for (const route of routes) {
        if (route.method !== (req.method ?? "GET")) continue;
        const params = match(route, parts);
        if (!params) continue;

        let cachedBody: string | undefined;
        const ctx: Ctx = {
          req,
          res,
          params,
          query: url.searchParams,
          user: await resolveUser(req),
          body: async <T,>() => {
            cachedBody ??= await readBody(req);
            return (cachedBody ? JSON.parse(cachedBody) : {}) as T;
          },
        };
        // Bind the conversation id for every /conversations/:id route in one place, so
        // their log lines carry it without being edited.
        const convId = params.id;
        const run = async () => {
          for (const g of guards) {
            const denied = await g(ctx);
            if (denied) return denied;
          }
          return route.handler(ctx);
        };
        const result = convId ? await withConversation(convId, run) : await run();
        if (result && typeof result === "object" && "json" in result) {
          res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result.json));
        }
        return true;
      }
      return false;
    },
  };
  return router;
}
