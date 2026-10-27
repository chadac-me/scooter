"""OpenTelemetry metrics for the scheduler service, matching services/agent-host/src/metrics/metrics.ts:
an OTLP exporter, a no-op sink when disabled, and an in-memory reader as a test seam.

Instruments:
  - scheduler_fires_total: Counter {status=spawned|delivered|failed}
  - scheduler_spawn_duration_ms: Histogram
  - scheduler_tick_duration_ms: Histogram
  - scheduler_ticks_total: Counter {outcome=ok|error}
  - scheduler_claim_lag_ms: Histogram
  - scheduler_tasks: ObservableGauge {enabled=true|false}
  - scheduler_due_backlog: ObservableGauge
  - scheduler_runs_pruned_total: Counter
  - scheduler_system_runs_total: Counter {status=succeeded|failed|timed_out}
  - scheduler_system_run_duration_ms: Histogram
  - scheduler_system_runs_skipped_total: Counter (a task still running when due again)

No instrument carries a task_id or owner attribute, since their cardinality is unbounded.
"""

from __future__ import annotations

from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.metrics import CallbackOptions, Observation
from opentelemetry.sdk.metrics import Counter, Histogram, MeterProvider, ObservableGauge
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource

from .logging_config import format_error, get_logger

logger = get_logger("metrics")


class MetricsSink:
    """Interface for recording metrics, with a no-op implementation when disabled."""

    def fire_started(self) -> None:
        """A task fire started."""
        pass

    def fire_completed(self, *, status: str, duration_ms: float) -> None:
        """A task fire completed with status spawned, delivered or failed."""
        pass

    def tick_started(self) -> None:
        """A scheduler tick started."""
        pass

    def tick_completed(self, *, outcome: str) -> None:
        """A scheduler tick completed with outcome ok or error, called every tick."""
        pass

    def claim_lag(self, *, lag_ms: float) -> None:
        """Record the lag between now and a task's next_run_at at claim time."""
        pass

    def set_task_counts(self, *, enabled: int, disabled: int) -> None:
        """Update the observable task count gauges."""
        pass

    def set_due_backlog(self, *, count: int) -> None:
        """Update the observable due-backlog gauge."""
        pass

    def runs_pruned(self, *, count: int) -> None:
        """Record the number of runs deleted by the retention sweep."""
        pass

    def system_run_completed(self, *, status: str, duration_ms: float) -> None:
        """A system-task run ended: succeeded, failed or timed_out."""
        pass

    def system_run_skipped(self) -> None:
        """A system task came due while its last run was still going."""
        pass

    async def shutdown(self) -> None:
        """Flush and shut down the exporter."""
        pass


class _OTelMetricsSink(MetricsSink):
    """Live OpenTelemetry metrics sink."""

    def __init__(self, reader):
        resource = Resource.create({"service.name": "agent-scheduler"})
        provider = MeterProvider(resource=resource, metric_readers=[reader])
        self._provider = provider
        meter = provider.get_meter("agent-scheduler")

        # Counters
        self._fires = meter.create_counter(
            "scheduler_fires_total",
            description="Task fires completed, by status (spawned|delivered|failed).",
        )
        self._ticks = meter.create_counter(
            "scheduler_ticks_total",
            description="Scheduler ticks completed, by outcome (ok|error). MUST increment every tick.",
        )
        self._runs_pruned = meter.create_counter(
            "scheduler_runs_pruned_total",
            description="Task runs deleted by the retention sweep.",
        )
        self._system_runs = meter.create_counter(
            "scheduler_system_runs_total",
            description="System-task runs ended, by status (succeeded|failed|timed_out).",
        )
        self._system_skipped = meter.create_counter(
            "scheduler_system_runs_skipped_total",
            description="System-task windows skipped because the last run was still going.",
        )
        self._system_duration = meter.create_histogram(
            "scheduler_system_run_duration_ms",
            description="System-task run duration, milliseconds.",
            unit="ms",
        )

        # Histograms
        self._spawn_duration = meter.create_histogram(
            "scheduler_spawn_duration_ms",
            description="Task spawn duration, milliseconds.",
            unit="ms",
        )
        self._tick_duration = meter.create_histogram(
            "scheduler_tick_duration_ms",
            description="Scheduler tick duration, milliseconds.",
            unit="ms",
        )
        self._claim_lag_hist = meter.create_histogram(
            "scheduler_claim_lag_ms",
            description="Lag between now and next_run_at at claim time, milliseconds.",
            unit="ms",
        )

        # Observable gauge values, read by the callbacks at collection time.
        self._task_count_enabled = 0
        self._task_count_disabled = 0
        self._due_backlog_count = 0
        # Instruments whose callback has already reported a failure (see _guarded).
        self._failed_instruments: set[str] = set()

        meter.create_observable_gauge(
            "scheduler_tasks",
            callbacks=[self._observe_tasks],
            description="Task count by enabled status.",
        )
        meter.create_observable_gauge(
            "scheduler_due_backlog",
            callbacks=[self._observe_backlog],
            description="Number of tasks currently overdue.",
        )

    # Observable-gauge callbacks return Observation objects, and each is wrapped because the
    # SDK would otherwise log a raising callback on every collection cycle forever.
    def _observe_tasks(self, options: CallbackOptions) -> list[Observation]:
        return self._guarded(
            "scheduler_tasks",
            lambda: [
                Observation(self._task_count_enabled, {"enabled": "true"}),
                Observation(self._task_count_disabled, {"enabled": "false"}),
            ],
        )

    def _observe_backlog(self, options: CallbackOptions) -> list[Observation]:
        return self._guarded("scheduler_due_backlog", lambda: [Observation(self._due_backlog_count)])

    def _guarded(self, instrument: str, build) -> list[Observation]:
        """Run a gauge callback body, converting a raise into a dropped data point that is logged once per failure episode."""
        try:
            observations = build()
        except Exception as e:
            if instrument not in self._failed_instruments:
                self._failed_instruments.add(instrument)
                logger.error(
                    "observable-gauge callback failed — dropping this data point",
                    extra={"instrument": instrument, "error": format_error(e)},
                )
            return []
        self._failed_instruments.discard(instrument)
        return observations

    def fire_completed(self, *, status: str, duration_ms: float) -> None:
        self._fires.add(1, {"status": status})
        self._spawn_duration.record(duration_ms)

    def tick_completed(self, *, outcome: str) -> None:
        self._ticks.add(1, {"outcome": outcome})

    def claim_lag(self, *, lag_ms: float) -> None:
        self._claim_lag_hist.record(lag_ms)

    # Coerced at the setter so a bad value is attributable to the caller that produced it.
    def set_task_counts(self, *, enabled: int, disabled: int) -> None:
        self._task_count_enabled = int(enabled)
        self._task_count_disabled = int(disabled)

    def set_due_backlog(self, *, count: int) -> None:
        self._due_backlog_count = int(count)

    def runs_pruned(self, *, count: int) -> None:
        self._runs_pruned.add(count)

    def system_run_completed(self, *, status: str, duration_ms: float) -> None:
        self._system_runs.add(1, {"status": status})
        self._system_duration.record(duration_ms)

    def system_run_skipped(self) -> None:
        self._system_skipped.add(1)

    async def shutdown(self) -> None:
        try:
            self._provider.shutdown()
        except Exception as e:
            logger.error("metrics shutdown failed", extra={"error": format_error(e)})


class _NoopMetricsSink(MetricsSink):
    """No-op sink when metrics are disabled."""

    pass


def create_metrics(*, enabled: bool, reader_for_test=None) -> MetricsSink:
    """Create a metrics sink: a no-op when disabled, else OTel with `reader_for_test` or an OTLP exporter."""
    if not enabled:
        return _NoopMetricsSink()

    # The OTLP exporter reads OTEL_EXPORTER_OTLP_* from the environment.
    reader = reader_for_test or PeriodicExportingMetricReader(OTLPMetricExporter())
    return _OTelMetricsSink(reader)
