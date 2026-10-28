# PR benchmarks: measured before/after on the PR comment

## Problem

Performance fixes merge on a local benchmark and a promise. #977 claims
~180ms → ~7ms of CPU for the warm-store PV list, but nothing in CI checks
that, and nothing would stop a later PR from quietly undoing it. #974 was
caught by a production timeout, not by CI.

## Proposal

A label-triggered, path-selected `bench` job that runs each affected service's benchmarks on
**both the PR and its merge base, on the same runner**, and posts a
before/after table as a section of the existing CI comment.

### Pieces

1. **Suites live beside the code**, e.g.
   `services/warm-store-controller/bench/`. Each is a flake app
   (`nix run .#bench-warm-store`) that runs one round and prints one JSON line
   per case, its median over that round's iterations:

   ```json
   {"suite": "warm-store", "side": "pr", "case": "list_pvs+pool_pvs/380", "unit": "ms_cpu", "value": 7.1}
   ```

   Python suites use plain `time.process_time` loops (no new dependency). The
   app takes `--src <dir>` and imports the service from there, so both sides
   run under the PR's interpreter and libraries and only the service code
   differs. The rounds' medians are the samples the comparison works on.

2. **A registry, `.github/benchmarks.yml`**, in the style of `ci-gates.yml`:

   ```yaml
   suites:
     - id: warm-store
       app: bench-warm-store
       src: services/warm-store-controller
       noise: 5
       paths:
         - services/warm-store-controller/**
         - modules/warm-store-controller.nix
   ```

   `bench-compare.mjs select` picks the suites whose paths the PR's diff
   touches. One job runs them in turn, so they share one comment section.

3. **A/B on one runner, `scripts/bench-ab.sh`.** Like `image-sizes`: check
   out the merge base in a worktree and run the PR's harness against both
   trees, **interleaved** for 8 rounds, alternating which side goes first, so
   runner drift affects both equally. A side that cannot run (a new suite, or a
   harness needing code the base lacks) is reported as having no baseline.

4. **`scripts/bench-compare.mjs`** reports, for each case, the median for each
   side, the change as a %, and a bootstrap 95% interval on the ratio. A change
   counts only if its whole interval clears the suite's noise floor
   (`noise`, default 5%). Output is markdown with the same `<details>` summary style
   as `e2e-full-compare.mjs`, posted with
   `ci-report.mjs post --section bench`.

5. **A `bench` gate in `ci-gates.yml`**: label-gated and advisory.

### What it measures

CPU time first, because GitHub runners' wall time is noisy and CPU time
tracks what a CFS limit actually throttles (the #974 failure mode). Wall time is
recorded where locking or contention is the point (`reserve during a pass`);
the bootstrap interval widens with its noise, so it is judged the same way.

### First suite: warm-store `/reserve`

- `list_pvs` + `pool_pvs` on a synthetic 380- and 2,000-PV list response
  (the body generator from the #977 benchmark).
- `reserve()` end to end against a stdlib fake API server in its own
  process (so its CPU stays out of the measurement), with no pass running and
  with passes running on another thread (the GIL contention seen in #974).
- `reconcile_once` over the same world.

Landing this with #977 would make that PR show its own speedup: the merge
base side is the old model-deserializing path.

## Alternatives

- **Compare against stored main results (artifacts) instead of A/B.**
  Cheaper, since one side per run, but each result comes from a different
  runner, and the e2e-full baseline window shows how much spread that adds.
  Lost on noise.
- **Count instructions (cachegrind) instead of CPU time.** This is nearly
  deterministic (<1% noise), but under valgrind CPython runs 20–50× slower,
  and allocator/GC behavior is not representative. Worth revisiting
  if CPU-time A/B turns out too noisy for small cases.
- **Benchmark against a live k3d cluster.** It measures the real thing,
  but costs e2e-full-level credits and its noise would swamp a 2× change. A
  `duration_ms` log line in Loki covers production instead.
- **Self-hosted runner for stable timings.** The e2e-full shards already use
  one, but it is shared with them and would add queueing to every matching PR.

## Decisions

- **Trigger: only with a `bench` label**, like `e2e-full`. A labelled PR
  runs the suites whose `paths` it touches; the paths in the registry only
  pick suites, they never start the job.
- **Enforcement: advisory.** The `bench` gate shows ⚠️ in the gate table on a
  regression and never blocks a merge.
- **First suite: warm-store-controller only.** Other services and other
  latency-sensitive paths are for a later PR.
