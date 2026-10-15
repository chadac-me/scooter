/**
 * Browser telemetry: OTLP traces from the UI, POSTed same-origin to `/telemetry/v1/traces`
 * where the UI's nginx forwards them to the cluster's collector (see
 * `pkgs/ui-image/default.nix`), so the browser holds no credential and the traffic stays
 * behind the ingress auth. Message content never leaves the browser through this path;
 * attributes are ids, counts, durations and error classes.
 */

import { context, trace, type Span, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  WebTracerProvider,
} from "@opentelemetry/sdk-trace-web";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

/** Where nginx proxies browser telemetry, same-origin by construction. */
const ENDPOINT = "/telemetry/v1/traces";

/** Attribute names, stable because dashboards and queries key on them; both conversation identifiers matter since the creation window spans them. */
export const ATTR = {
  /** Stable local key, present for the conversation's whole life. */
  conversationKey: "scooter.conversation.key",
  /** The server's id, absent until the conversation has been created. */
  conversationId: "scooter.conversation.id",
  runId: "scooter.run.id",
  /** Why a stream closed or reopened. */
  reason: "scooter.reason",
} as const;

/** Matches a conversation id in a request URL. */
const CONV_URL_RE = /\/conversations\/([0-9a-f-]{36})/;

/** Span attributes the fetch instrumentation records the request URL on, newest semconv first. */
const SPAN_URL_ATTRS = ["url.full", "http.url"] as const;

/**
 * The traced request's URL. The fetch instrumentation hands this callback the second
 * `fetch` argument, so a `fetch(url, init)` call — which is every call site in this UI —
 * passes a RequestInit with no `url`, and only the span carries the URL by then.
 */
export function tracedRequestUrl(request: unknown, span: Span): string {
  if (typeof request === "string") return request;
  const own = (request as { url?: unknown } | null | undefined)?.url;
  if (typeof own === "string") return own;
  const attrs = (span as unknown as { attributes?: Record<string, unknown> }).attributes;
  for (const key of SPAN_URL_ATTRS) {
    const value = attrs?.[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/** Bucket a request into a low-cardinality kind so traces group by what the request was. */
export function classifyRoute(url: string): string {
  // "unknown" is kept distinct from "other" so a URL we failed to read can never hide
  // among the routes we simply do not classify.
  if (!url) return "unknown";
  const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
  if (path.endsWith("/messages")) return "send-message";
  if (path.includes("events.integrity")) return "stream";
  if (path.endsWith("/conversations/events")) return "list-stream";
  if (path.endsWith("/cancel")) return "cancel";
  if (path.endsWith("/ready")) return "ready";
  if (path.endsWith("/links")) return "links";
  if (path.endsWith("/history")) return "history";
  if (path.endsWith("/tail")) return "tail";
  if (path.endsWith("/shares")) return "shares";
  if (path.includes("/web-services")) return "web-services";
  if (path.includes("/module-registry") || path.includes("/modules/")) return "modules";
  if (path.endsWith("/resources") || path.endsWith("/size")) return "sandbox-resources";
  if (path.endsWith("/resume")) return "resume";
  if (path.endsWith("/title") || path.endsWith("/starred")) return "conversation-edit";
  if (path.endsWith("/compact")) return "compact";
  if (path === "/conversations") return "list-or-create";
  if (path === "/models") return "models";
  if (path === "/agui") return "agui";
  return "other";
}

let tracer: Tracer | undefined;

/** Fetch the deployment's telemetry config (served by nginx at runtime, since the image is built once) and start if enabled; never throws. */
export async function initTelemetryFromServer(): Promise<void> {
  // VITE_TELEMETRY_CONSOLE=1 prints spans to the browser console instead, which Playwright forwards into the test output.
  if (import.meta.env.VITE_TELEMETRY_CONSOLE === "1") {
    initTelemetry({ enabled: true, exporter: "console" });
    return;
  }
  try {
    const res = await fetch("/telemetry/config.json", { cache: "no-store" });
    if (!res.ok) return;
    const cfg = (await res.json()) as { enabled?: boolean; sampleRatio?: number; version?: string };
    if (!cfg.enabled) return;
    initTelemetry({ enabled: true, sampleRatio: cfg.sampleRatio, version: cfg.version });
  } catch {
    /* no config means no telemetry */
  }
}

/** Start telemetry; a no-op unless enabled, and never throws. */
export function initTelemetry(opts: {
  enabled: boolean;
  sampleRatio?: number;
  version?: string;
  /** "console" prints each span as a line instead of exporting OTLP. */
  exporter?: "otlp" | "console";
}): void {
  if (!opts.enabled || tracer) return;
  try {
    const provider = new WebTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: "scooter-ui",
        [ATTR_SERVICE_VERSION]: opts.version ?? "dev",
      }),
      // Head sampling, since a live event stream produces many spans.
      sampler: new TraceIdRatioBasedSampler(opts.sampleRatio ?? 1),
      spanProcessors: opts.exporter === "console"
        ? [
            // One greppable line per span, unbatched so a span is not lost when the tab closes.
            new SimpleSpanProcessor({
              export: (spans, cb) => {
                for (const sp of spans) {
                  const attrs = Object.entries(sp.attributes)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(" ");
                  // eslint-disable-next-line no-console
                  console.log(`scooter.span ${sp.name}${attrs ? ` ${attrs}` : ""}`);
                }
                cb({ code: 0 });
              },
              shutdown: async () => {},
            }),
          ]
        : [
        new BatchSpanProcessor(new OTLPTraceExporter({ url: ENDPOINT }), {
          // Small batches and a short delay, because a tab can close at any moment.
          scheduledDelayMillis: 5_000,
          maxExportBatchSize: 64,
        }),
      ],
    });
    provider.register();

    registerInstrumentations({
      instrumentations: [
        new FetchInstrumentation({
          // Tracing the telemetry POST itself would export a span per export forever.
          ignoreUrls: [new RegExp(`${ENDPOINT}`)],
          // Trace context goes to our own backend only, since a third party would trip CORS and see trace ids.
          propagateTraceHeaderCorsUrls: [new RegExp(`^${location.origin}`)],
          // Tag every request with its conversation and outcome.
          applyCustomAttributesOnSpan: (span, request, result) => {
            const url = tracedRequestUrl(request, span);
            const conv = CONV_URL_RE.exec(url)?.[1];
            if (conv) span.setAttribute(ATTR.conversationId, conv);
            span.setAttribute("http.route_kind", classifyRoute(url));
            if (result instanceof Error) {
              span.setAttribute("http.failed", true);
              span.setAttribute(ATTR.reason, result.message.slice(0, 200));
            } else if (result && typeof (result as Response).status === "number") {
              const status = (result as Response).status;
              span.setAttribute("http.status_code", status);
              if (status >= 400) span.setAttribute("http.failed", true);
            }
          },
        }),
      ],
    });

    tracer = provider.getTracer("scooter-ui");
  } catch {
    // An undefined `tracer` makes every record()/startSpan() a no-op.
  }
}

/** Record a point-in-time event as a zero-duration span, a no-op before init. */
export function record(name: string, attrs: Record<string, string | number | boolean> = {}): void {
  try {
    tracer?.startSpan(name, { attributes: attrs }).end();
  } catch {
    /* never let telemetry throw into a caller */
  }
}

/** Start a span the caller ends. Returns undefined when telemetry is off. */
export function startSpan(
  name: string,
  attrs: Record<string, string | number | boolean> = {},
): Span | undefined {
  try {
    return tracer?.startSpan(name, { attributes: attrs });
  } catch {
    return undefined;
  }
}

/** Record a caught error against the active span, or as its own event. */
export function recordError(name: string, err: unknown, attrs: Record<string, string> = {}): void {
  try {
    const message = err instanceof Error ? err.message : String(err);
    const active = trace.getSpan(context.active());
    if (active) {
      active.recordException(err instanceof Error ? err : new Error(message));
      return;
    }
    record(name, { ...attrs, "error.message": message });
  } catch {
    /* never let telemetry throw into a caller */
  }
}

/** Catch what would otherwise only reach the browser console, installed before init completes since record() is a no-op until then. */
export function installGlobalErrorHandlers(): void {
  window.addEventListener("error", (e) => {
    record("browser.error", {
      "error.message": e.message,
      "error.source": `${e.filename}:${e.lineno}`,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r: unknown = e.reason;
    record("browser.unhandled_rejection", {
      "error.message": r instanceof Error ? r.message : String(r),
    });
  });
}
