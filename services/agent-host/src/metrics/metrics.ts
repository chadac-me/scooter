/**
 * OpenTelemetry metrics for the agent-host over OTLP: operational metrics (run
 * count and duration by model and outcome, sandbox gauges, errors) and cost/usage
 * metrics (per-run token counts from goose's session DB via gooseUsage.ts and the
 * derived USD cost via pricing.ts). Configured by the standard OTEL_EXPORTER_OTLP_*
 * env vars plus an on/off flag; when disabled, createMetrics() returns a no-op sink
 * so call sites stay unconditional. The rest of the codebase depends only on the
 * MetricsSink interface, never on OTel types.
 */

import { metrics, type Counter, type Histogram, type ObservableGauge } from "@opentelemetry/api";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from "@opentelemetry/semantic-conventions";

import { computeCost, type PriceTable } from "./pricing.js";
import type { GooseUsageReader } from "./gooseUsage.js";
import { debug, debugError } from "../debug.js";

/** What the app reports. A no-op implementation is used when metrics are off. */
export interface MetricsSink {
  /** A run started for a conversation on a given model. */
  runStarted(attrs: { conversationId: string; model: string }): void;

  /** A run finished: records count and duration, and asynchronously emits the session's token-usage delta and derived cost when a usage reader is configured. */
  runFinished(attrs: {
    conversationId: string;
    model: string;
    acpSessionId: string;
    durationMs: number;
    outcome: "ok" | "error";
    /** The conversation owner's user id and email for per-user cost attribution; undefined buckets as "anonymous". */
    ownerId?: string;
    ownerEmail?: string | null;
  }): void;

  /** Observed sandbox population (emitted from the idle sweep / provisioner). */
  setSandboxCounts(counts: { running: number; suspended: number }): void;

  /** A broker request passed through (provider + outcome), if wired. */
  brokerRequest?(attrs: { provider: string; outcome: "ok" | "error" }): void;

  /** A durable conversation-log append failed, losing a turn. */
  persistenceError?(attrs: { conversationId: string }): void;

  /** Flush + shut down the exporter (called on graceful shutdown). */
  shutdown(): Promise<void>;
}

export interface MetricsConfig {
  /** Master switch; off makes createMetrics return the no-op sink. */
  enabled: boolean;
  /** Logical service name (resource attribute service.name). */
  serviceName: string;
  /** deployment.environment resource attribute (e.g. "dev", "prod"). */
  environment?: string;
  /** The per-model price table for cost derivation; empty means tokens only, no cost. */
  prices: PriceTable;
  /** Reads token usage per session for cost metrics; omit to emit operational metrics only. */
  usageReader?: GooseUsageReader;
  /** Test seam: an alternate MetricReader in place of the OTLP/periodic exporter, typed loosely to keep the SDK type out of the public interface. */
  readerForTest?: unknown;
}

/** Build the metrics sink: a no-op when disabled, otherwise an OTel MeterProvider with an OTLP exporter and the instruments. */
export function createMetrics(config: MetricsConfig): MetricsSink {
  if (!config.enabled) return noopMetrics();

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    ...(config.environment ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment } : {}),
  });
  // The OTLP exporter reads OTEL_EXPORTER_OTLP_* from the environment itself.
  const reader =
    (config.readerForTest as PeriodicExportingMetricReader | undefined) ??
    new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() });
  const provider = new MeterProvider({ resource, readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  const meter = provider.getMeter("agent-host");

  // --- Instruments ---------------------------------------------------------
  const runs: Counter = meter.createCounter("agent_runs_total", {
    description: "Agent runs (prompts) completed, by model + outcome.",
  });
  const runDuration: Histogram = meter.createHistogram("agent_run_duration_ms", {
    description: "Wall-clock duration of an agent run, ms.",
    unit: "ms",
  });
  const tokens: Counter = meter.createCounter("agent_tokens_total", {
    description: "Tokens used, by model + token kind (input/output/cache_read/cache_write).",
  });
  const cost: Counter = meter.createCounter("agent_cost_usd_total", {
    description: "Derived cost in USD (tokens × price table), by model.",
    unit: "USD",
  });
  const brokerReqs: Counter = meter.createCounter("agent_broker_requests_total", {
    description: "Broker requests, by provider + outcome.",
  });
  const persistenceErrors: Counter = meter.createCounter("agent_persistence_errors_total", {
    description: "Durable conversation-log append failures (a turn was lost).",
  });

  // Sandbox population is set from outside and read by the gauge at collection time.
  let sandboxRunning = 0;
  let sandboxSuspended = 0;
  const sandboxGauge: ObservableGauge = meter.createObservableGauge("agent_sandboxes", {
    description: "Sandbox population by state.",
  });
  sandboxGauge.addCallback((obs) => {
    obs.observe(sandboxRunning, { state: "running" });
    obs.observe(sandboxSuspended, { state: "suspended" });
  });

  // Per-session usage already counted, so only the per-run delta is emitted.
  const lastUsage = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();

  const emitUsageDelta = async (
    acpSessionId: string,
    model: string,
    user: { user_id: string; user_email: string },
  ): Promise<void> => {
    const reader = config.usageReader;
    if (!reader) return;
    try {
      const u = await reader.readSessionUsage(acpSessionId);
      if (!u) return; // no DB or unknown session
      const cur = {
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cacheRead: u.cachedReadTokens ?? 0,
        cacheWrite: u.cachedWriteTokens ?? 0,
      };
      const prev = lastUsage.get(acpSessionId) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const delta = {
        input: Math.max(0, cur.input - prev.input),
        output: Math.max(0, cur.output - prev.output),
        cacheRead: Math.max(0, cur.cacheRead - prev.cacheRead),
        cacheWrite: Math.max(0, cur.cacheWrite - prev.cacheWrite),
      };
      lastUsage.set(acpSessionId, cur);

      const base = { model, ...user };
      if (delta.input) tokens.add(delta.input, { ...base, kind: "input" });
      if (delta.output) tokens.add(delta.output, { ...base, kind: "output" });
      if (delta.cacheRead) tokens.add(delta.cacheRead, { ...base, kind: "cache_read" });
      if (delta.cacheWrite) tokens.add(delta.cacheWrite, { ...base, kind: "cache_write" });

      const c = computeCost(
        model,
        {
          inputTokens: delta.input,
          outputTokens: delta.output,
          cachedReadTokens: delta.cacheRead,
          cachedWriteTokens: delta.cacheWrite,
        },
        config.prices,
      );
      if (c.priced && c.totalCost > 0) cost.add(c.totalCost, base);
      else if (!c.priced) debug("[metrics] no price for model %s; tokens counted, cost omitted", model);
    } catch (err) {
      debugError("[metrics] usage/cost emit failed:", err);
    }
  };

  return {
    runStarted() {
      // Runs are counted on finish.
    },

    runFinished(attrs) {
      runs.add(1, { model: attrs.model, outcome: attrs.outcome });
      runDuration.record(attrs.durationMs, { model: attrs.model, outcome: attrs.outcome });
      // Unowned buckets as "anonymous" so no cost goes uncounted.
      const user = {
        user_id: attrs.ownerId || "anonymous",
        user_email: attrs.ownerEmail || "",
      };
      // The token/cost read is best-effort and must not block the run.
      void emitUsageDelta(attrs.acpSessionId, attrs.model, user);
    },

    setSandboxCounts(counts) {
      sandboxRunning = counts.running;
      sandboxSuspended = counts.suspended;
    },

    brokerRequest(attrs) {
      brokerReqs.add(1, { provider: attrs.provider, outcome: attrs.outcome });
    },

    persistenceError(attrs) {
      persistenceErrors.add(1, { conversationId: attrs.conversationId });
    },

    async shutdown() {
      try {
        await provider.shutdown(); // flushes the exporter
      } catch (err) {
        debugError("[metrics] shutdown failed:", err);
      }
      await config.usageReader?.close();
    },
  };
}

/** The no-op sink used when metrics are disabled or in tests. */
export function noopMetrics(): MetricsSink {
  return {
    runStarted() {},
    runFinished() {},
    setSandboxCounts() {},
    brokerRequest() {},
    persistenceError() {},
    async shutdown() {},
  };
}
