# Warm overlay PVs: reuse what suspended sandboxes are not using

Status: accepted, implemented in #970 · 2026-10-27

## Problem

Intent: an overlay-store volume (`scooter-rw`, the writable upper of `/nix`) is in use
only while its sandbox is **running**. Once the sandbox suspends, the volume should go
back to a pool and the next new or resuming sandbox should pick it up.

In practice, no volume has been reused in the last 7 days. From Loki and kube-state-metrics:

| Signal (last 7 days) | Value |
|---|---|
| `placed a warm PV` / `returned a PV to the pool` / `adopted a PV into the pool` | **0 / 0 / 0** |
| `scooter-rw-*` PVCs Bound right now | 61, all on the default `local-path` class |
| Sandbox pods running right now | 5 |
| PVs in `Released`, never cleaned up | 38 → 65 → 70 → **83** (7d, 3d, 1d ago, now) |
| Warm PVCs deleted by the controller (`retired-tag` 38 + `warm-failed` 9) | 47 |
| `reaped expired overlay store` (208 distinct PVCs, most reaped 18×) | 2842 |

So about 56 of the 61 overlay PVs belong to suspended sandboxes. The Released pile grows
by roughly one PV for each warm PVC the controller deletes.

## Root causes

1. **A suspended sandbox keeps its overlay for 7 days.** Suspend sets
   `operatingMode: Suspended`, which drops the pod but keeps the PVCs. The only thing
   that frees the overlay is the conversation-controller's `reap_overlays`, after
   `overlayRetentionSeconds` (7d). That is where the ~56 held PVs come from.
2. **Overlays never enter the pool to begin with.** The `scooter-rw` volumeClaimTemplate
   has no `storageClassName`. agent-sandbox creates the PVC as soon as the Sandbox exists,
   on `local-path` (reclaim `Delete`). The warm-store controller polls every 10s and
   only places a PV or grows the pool if the PVC does not exist yet, so it nearly always
   loses that race. The 20 `grew the warm pool` wins were also lost later: after the
   reaper deleted one of them, agent-sandbox recreated it on `local-path` (cause 4).
3. **Pool PVs are never labeled, so they can't be recycled.** `adopt_bound_pvs` is
   called with the names in `pending`. `pending` means "sandboxes whose PVC does not exist
   yet", so every read 404s and no PV ever gets `scooter.io/warm-store`.
   `iter_pool_pvs` selects on that label. As a result, a Retain-class PV whose PVC is
   deleted goes `Released` and stays there, invisible to the controller. That is the 83,
   and each one is 20Gi of node disk.
4. **The warm PVC pool is dead code that costs a full sandbox boot per deploy.**
   `reconcile.py` (`warming → ready → claimed → ready`) relies on the agent-host to
   label a PVC `claimed-by`, and nothing in the agent-host does that. A `ready` warm PVC's
   PV is bound to that PVC, so PV placement can't hand it out either. Every image-tag
   change warms a new PVC (a Job that boots the sandbox) and deletes the previous one
   as `retired-tag`, which leaks its unlabeled Retain PV (cause 3).
5. **The reaper and agent-sandbox keep undoing each other.** On each resync (about every
   10h) agent-sandbox recreates the vct PVC for every suspended Sandbox, and the
   reaper deletes it again a minute later. Under `WaitForFirstConsumer` no PV gets
   provisioned, so this only costs churn (about 190 deletes per resync). It does mean
   a resuming sandbox always finds a fresh `local-path` PVC waiting, which locks the pool out.
6. **Latent: node pinning is ignored.** Both overlay and workspace are node-local
   (`local-path`). On resume, the workspace PV already fixes the node. If the controller
   ever placed an overlay PV from a different node, the pod would never schedule.
   `usable_pvs` only checks that some node is schedulable.

## Proposal

**One set of PVs in two pools (warm and returned), allocated at claim time by the
controller (on a synchronous call from the agent-host), released on suspend, and sized to demand.**

### Two pools, one PV set

Every idle (`Available`) pool PV carries `scooter.io/pool`:

| Pool | How a PV gets there | Contents | Who may take it | Sized by |
|---|---|---|---|---|
| `warm` | Top-up: dynamic provision + warm Job | `goldenExpr` only, tenant-neutral | Any sandbox on the current tag | Arrival rate (below) |
| `returned` | Released on suspend, recycled | Whatever its last sandbox built | Its last sandbox first, then any sandbox (LRU) | `maxReturned` cap + `returnedTtl`, LRU |

The pools are labels on the same PVs, not separate storage classes, so a PV changes pool
without being copied. Keeping them apart stops a burst of new sandboxes from draining
the volumes that suspended sandboxes will want back. It also stops resumes from taking
every clean warm PV that new arrivals need.

### Sizing: grow and shrink with arrivals

Sizing is split into three parts that only talk through plain data. None of them sits on
the allocation path, so changing the policy never touches how a sandbox gets its PV.

```
 signals (observed)         policy (pure)                  actuator (controller)
 ──────────────────         ─────────────                  ─────────────────────
 arrivals, misses,    ──▶   target(snapshot, now)   ──▶    grow / shrink toward
 pool state, Job times      → {(tag, node): count}         {(tag, node): count}
```

- **Signals.** The controller gathers a `Snapshot` each pass: Sandbox creation
  timestamps, allocation misses, `Available`/`Bound` PVs by tag, pool and node, and recent
  warm-Job durations. The `/reserve` handler only *emits* a miss (a counter plus a log line). It never
  changes a target itself.
- **Policy.** `SizingPolicy.target(snapshot, now)` is a pure function with no k8s or I/O,
  unit-tested the same way as `reconcile.py`. It returns the desired `Available warm`
  count per tag and node. It may look at anything in the snapshot, or at nothing:
  - `fixed`: always `minWarm`, which is today's behaviour.
  - `reactive` (default): `clamp(ceil(arrivals / window × lead × headroom) + recent misses,
    minWarm, maxWarm)`, where `lead` is the p90 warm-Job duration. Each node gets a share
    in proportion to its recent arrivals.
  - Later, **anticipatory** policies plug in here without touching anything else: a time-of-day
    profile learned from past arrivals, a calendar ("pre-warm 10 before 9am weekdays"),
    or a pre-warm before an image-tag rollout. Policies compose by taking the `max` of
    their targets.
- **Actuator.** The actuator is the only part that changes the cluster, and it has no
  opinion on what the target should be.
  - **Grow** when `Available warm < target`: start warm Jobs for the gap, at most
    `maxWarmJobs` at a time, so a spike doesn't flood the nodes with boots.
  - **Shrink** only after `Available warm > target` has held for `cooldown` (default 30m).
    Retire LRU first, one per pass, so a policy that changes its mind doesn't make the pool flap.
  - `maxWarm` is a hard cap here as well, whatever the policy asks for.

The policy is chosen by `warmStore.sizing.policy`, and its parameters sit under
`warmStore.sizing.<policy>`.

The `returned` pool never grows on its own, because only suspends feed it. It shrinks,
LRU first, past `maxReturned` or when a PV has sat longer than `returnedTtl`. Any
conversation may take a returned PV, so idle returned PVs count toward the warm target.

### Lifecycle

```
           dynamic provision (pool class, Retain)      warm Job finishes
                         │                                    │
                         ▼                                    ▼
 ┌──────────┐ claimRef ┌──────┐  sandbox suspends or  ┌──────────┐  clear claimRef  ┌───────────┐
 │Available │ ───────▶ │Bound │ ───── is destroyed ──▶ │ Released │ ───────────────▶ │ Available │
 └──────────┘          └──────┘  (PVC deleted)         └──────────┘                  └───────────┘
       │ over idle cap / retired tag: claimRef → tombstone, reclaimPolicy → Delete
       ▼
   provisioner wipes the disk
```

### Changes

1. **Overlay vct on the pool class.** The provisioner sets
   `storageClassName: <warmStore.storageClass>` on the `scooter-rw` template for new
   Sandboxes. Existing Sandboxes keep their `local-path` template (we never patch vcts).
   They don't join the pool, but change 3 still frees their disk on suspend.
2. **Allocate before the pod exists.** On create and on resume, before setting
   `operatingMode: Running`, the provisioner calls the warm-store controller's
   `POST /reserve` (see *Reserve API*). The controller picks a PV and pre-binds it by setting
   `PV.spec.claimRef = {namespace, name: scooter-rw-<sandbox>}`, with the PV's
   `resourceVersion` as a compare-and-swap. This is Kubernetes' documented "reserve a PV"
   pattern: the PV controller binds whatever PVC turns up under that name, whether
   agent-sandbox creates it fresh or recreates it on resync. Candidates are filtered and ordered as follows:
   - same image tag, `Available`, not terminating;
   - **on resume, the node must match the workspace PV's node affinity** (cause 6);
   - **first: its own previous PV**, the one whose `scooter.io/last-sandbox` names this
     sandbox, provided it is still `Available` (no one else has claimed it);
   - **otherwise: the oldest unclaimed PV**, ordered by `scooter.io/released-at`. Warm PVs
     have never been owned, so they sort as oldest and go first. After them come returned
     PVs, longest-idle first, from any conversation (see *Decisions*). Today's order is
     most-recent-first, which is the reverse.
   - Together, these give each owner an implicit grace period. A just-suspended sandbox's
     PV is the last one handed out, so its owner can usually reclaim it on resume, and
     nothing is held to make that happen. The window stretches or shrinks with load, and
     the warm-pool target keeps it from collapsing under normal traffic.
   - A claim never takes a `Bound` PV, its own included.
   - If nothing matches, do nothing. The PVC dynamically provisions on the pool class,
     never blocking.
3. **Release on suspend, after a clean-shutdown check.** Once the pod is gone, the
   provisioner labels `scooter-rw-<sandbox>` with `scooter.io/release=requested` (it needs
   no PV RBAC to do this). The controller then:
   1. runs the existing clean-marker reader Job against that PVC. It is pinned to the PV's
      node and mounts the volume read-only;
   2. **clean**: annotates the PV `scooter.io/shutdown=clean` and deletes the PVC, and the
      PV goes on to the recycle path;
   3. **dirty** (marker definitively absent: OOM kill, node loss, SIGKILL): deletes the PVC
      and retires the PV, wiping it;
   4. **unknown** (the read failed): backs off and retries, then retires after
      `markerRetries` attempts. An unreadable volume is never handed out.

   The PVC stays in place until the check finishes, so the existing PVC-based reader works
   unchanged. If the sandbox resumes during the check, `/reserve` sees its own `claimRef`,
   clears the release label and returns the same PV, since a crash-dirty upper is still
   fine for its own owner. The `pvc-protection` finalizer holds the delete until no pod
   mounts the PVC, so a double mount can't happen. On destroy, the PVC goes
   with the Sandbox (owner GC), so no check runs and the recycle path retires that PV.
4. **Controller serves reservations and does the upkeep.** Its pass-based PV placement
   (`list_pending_uppers`/`grow_pool`) is replaced by the synchronous reserve call. Each pass:
   - **Label** every pool-class PV whose claim is `scooter-rw-*` or a warm PVC: set
     `scooter.io/warm-store=<tag>` and annotate `scooter.io/last-sandbox`. This fixes cause 3
     by keying on the bound PVC, not on the "pending" list.
   - **Recycle** labeled `Released` PVs annotated `scooter.io/shutdown=clean` by clearing
     `claimRef` (the code for this already exists) and stamping
     `scooter.io/released-at`, which the claim order sorts on.
     A `Released` PV without that annotation (destroyed, or released by hand) is retired.
   - **Retire** PVs with a retired tag, and `Available` PVs the sizing pass shrinks away
     (LRU). To retire one, point its `claimRef` at a tombstone name and set
     `persistentVolumeReclaimPolicy: Delete`, so the provisioner actually wipes the disk.
     Today's plain PV delete under Retain leaves the data on the node.
   - **Size** both pools as described in *Sizing*: grow the warm pool toward its
     demand-driven target and shrink either pool LRU-first. A new warm PV runs the warm
     Job as today. When it succeeds (the seed stamps the marker), the controller annotates
     `shutdown=clean` and deletes the warm PVC, and the PV joins `warm`
     through the recycle path. A recycled sandbox PV joins `returned`.
5. **Delete the dead code.** That means `reconcile.py`'s PVC state machine
   (`claimed`/`ready`/return-on-suspend), `list_pending_uppers`/`grow_pool`/`reserve_pv`, and the in-memory `affinity` map, which
   moves to the PV annotation so it survives restarts.
6. **Conversation-controller overlay reaper:** keep it only for legacy `local-path`
   overlays, and drop it when the last one is gone. With change 3 it becomes a no-op for
   new Sandboxes, which also ends the resync churn (cause 5).
7. **Options:** replace `minReady`/`maxTotal` with `minWarm`/`maxWarm` (bounds on the warm
   target), `maxWarmJobs`, `cooldown`, `sizing.policy` (+ per-policy params such as `window`), `maxReturned` and `returnedTtl`. All of them
   cap `Available` PVs only, not every PV. Since PVs are no longer held while suspended, the
   steady-state PV count works out to *running sandboxes + warm target + idle returned PVs*.

### Reserve API

The controller is the only component with PV write RBAC. The agent-host gets no new
cluster-scoped permissions.

```
POST /reserve   {sandbox, tag}   →  200 {pv: "<name>" | null, pool: "warm"|"returned"|null, reason}
```

- **Leader only.** The handler runs in the leader. A non-leader replica's readiness probe
  fails, so the `warm-store-controller` Service routes only to the leader. During a
  failover the call fails and the provisioner falls back (below).
- **Auth.** The provisioner sends a projected ServiceAccount token with audience
  `warm-store`. The controller checks it with a TokenReview and accepts only the agent-host
  ServiceAccount. This is the same pattern the conversation-router already uses.
- **Idempotent.** If a PV's `claimRef` already names `scooter-rw-<sandbox>`, it is
  returned as-is. A retried call never takes a second PV.
- **Serialized.** The leader handles one reservation at a time, under the same lock as the
  pass's PV writes. It lists PVs fresh for each call (a few hundred objects), and resolves
  the node from the sandbox's workspace PV itself, so the caller sends no node. The claimRef
  CAS still guards against anything else writing; on a conflict it tries the next
  candidate, at most 3 times.
- **Never blocks.** The provisioner waits at most `reserveTimeout` (default 2s). On a
  timeout, error, or `pv: null`, it proceeds anyway and the PVC dynamically provisions on
  the pool class. The controller counts every `null` as a miss, and the sizing policy reads
  that count directly.
- **Late reservations.** If the provisioner gave up but the controller still bound a PV, the
  PVC binds to it as long as the PVC doesn't exist yet. Otherwise the janitor's pass finds
  a claimRef with no matching PVC after a grace period and clears it.

### One-off cleanup

The 83 `Released` PVs predate the fix and carry no label. After checking that each one
is on the pool class and has no live claim, flip each to `reclaimPolicy: Delete` so the
provisioner wipes it. Before running it, I'll list them with
`kubectl get pv -o wide | grep Released` and check them by hand.

### Expected effect

Today ~61 overlay PVs are in use, plus 83 leaked. At today's traffic it should then be about 5 (running)
+ a warm target of 1–2 + ≤ `maxReturned` (say 5), so roughly 12 overlay PVs. That number
rises with load and falls back after `cooldown`. Disk use falls with it: about 140 × 20Gi
of reservations stop being held.

## Alternatives considered

- **Shorten `overlayRetentionSeconds` to minutes.** This is a one-line config change,
  but it only frees disk: a reaped `local-path` PV is deleted, not reused, and the next
  resume starts cold. It doesn't fix causes 2–4.
- **A single pool with a fixed `minReady`/`maxTotal`** (the first draft). It can't absorb
  a burst of new sandboxes, it holds idle PVs overnight, and new arrivals can take the PVs
  that suspended sandboxes are about to resume onto.
- **A separate storage class per pool.** Moving a PV between pools would then mean
  copying it, and a label does the same job without that.
- **Keep allocation in the controller and make it watch-driven.** It is still a race against
  agent-sandbox creating the PVC. The only robust fix is to allocate *before* the
  Sandbox goes Running, which is why the provisioner calls `/reserve` synchronously.
- **Have the agent-host provisioner allocate directly.** That would remove a hop, but the
  agent-host would need a ClusterRole to patch `persistentvolumes`. Keeping PV writes in the
  controller confines that privilege to one small service.
- **Only the same owner may reuse a returned PV.** That is safer on a multi-tenant cluster,
  but this cluster is single-tenant, and it would sharply cut the hit rate.
- **Rely on native PV matching** (a pool-class PVC with no `volumeName` binds any
  `Available` PV that fits). That ignores the image tag. A `selector` on the tag would
  fix that, but it disables dynamic provisioning, so a pool miss would block the sandbox.
- **Move the overlay out of `volumeClaimTemplates`** and have the provisioner create the
  PVC. This also stops the resync recreation, but it needs a Sandbox migration, and the
  claimRef pre-bind gets the same result without touching existing CRs.

## Decisions

- **Allocator: the warm-store controller, via a synchronous reserve call.** It keeps PV
  RBAC out of the agent-host. See *Reserve API*.
- **Tenancy: any conversation may take any returned PV.** The cluster is single-tenant,
  so reuse is maximised. The accepted risk: an upper carries the previous conversation's
  `/nix`, including any secret a derivation embedded. If the cluster ever goes
  multi-tenant, add a `scooter.io/owner` label and match on it in `/reserve`.
  - The broker already keeps credentials out of the sandbox, which covers most of the
    risk. Agents also get told directly: a short "the Nix store is shared" section in
    `skills/nix-packages.md` (plus a pointer in `nix-dev-env.md`). It says not to put
    tokens, keys or private data into anything that lands in `/nix`: no secrets in
    derivation inputs or `fetch*` URLs, no `nix profile install` of generated files that
    hold secrets, and no `builtins.readFile` on secret paths. Put secrets in env vars or
    `/workspace` instead, which never leave the conversation.

- **Release immediately on suspend. Protect owners through claim order, not by holding PVs.**
  A claim takes its own previous PV if it's still unclaimed, else the oldest unclaimed PV
  (change 2). Recently released PVs are therefore handed out last, so owners can usually
  reclaim theirs. A fixed grace period would hold idle PVs to get the same result.

- **Check the clean-shutdown marker on every release, and retire dirty volumes.** A crashed
  sandbox's upper may hold a half-written Nix db or partial store paths. Handing that to
  another conversation risks a confusing failure that is hard to trace back. The cost is
  one short reader Job per release, which is cheap at our suspend rate (change 3).

## Open questions

None. All decisions are recorded above.

## Later optimizations (out of scope here)

- **Workspace PVCs.** There are 293 Bound `workspace-*` PVCs, because conversation retention
  (`retentionMaxAgeMs`) is off. They are 5× the overlay problem, but they hold user data, so they
  need a separate policy (archive to object storage, or retention with a warning).
- **Bound upper growth.** Run `nix-collect-garbage` against the upper's own db before
  returning a PV, so pooled volumes don't creep toward 20Gi.
- **Pool metrics.** Export gauges for Available/Bound/Released by tag and pool, the warm
  target per policy, and the miss counter from *Sizing*, so a regression like this one shows up on a dashboard instead of in
  a PV count.
- **Node balance.** Hand-outs pin sandboxes to the nodes where idle PVs live. Watch for
  `Pending` pods and prefer PVs on less-loaded nodes.
- **Warm what users actually build.** Seed `goldenExpr` from the store paths most often
  found in returned uppers, instead of a fixed `jq`.
