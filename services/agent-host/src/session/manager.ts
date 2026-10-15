/**
 * Session manager: owns conversation lifecycle in the agent-host.
 *
 * Per conversation it ties together a cold per-conversation Sandbox (the
 * provisioner), a goose ACP process behind the ACP<->AG-UI bridge (SessionBridge),
 * the durable event log and metadata (the store), and the AG-UI connections to
 * the browser.
 */

import type { SessionId, ThreadId, SandboxRef } from "../types.js";
import type { JobRecord } from "./jobManager.js";
import type { SessionBridge, AguiEvent, InterruptPolicy, PromptImage, PromptFile } from "../bridge.js";
import { danglingRunInfo, orphanRuns } from "./danglingRun.js";
import { allowAllGuard, type OwnershipGuard } from "./ownershipGuard.js";
import { noopRegistry, type ConversationRegistry } from "./conversationRegistry.js";
import { formatError, logger } from "../log.js";

const log = logger("manager");

/** The synthetic prompt sent to resume a run interrupted by an agent-host restart: a nudge to
 *  continue rather than the user's literal prompt, which would redo work. */
const RESUME_NUDGE =
  "[System: this conversation was interrupted by a restart while you were working. " +
  "Continue where you left off — do NOT restart the task, re-introduce yourself, or " +
  "repeat a message/comment you already posted. If you had already finished, a brief " +
  "status is fine.]";

/** The synthetic prompt sent after an agent-initiated model switch, whose turn was cancelled to
 *  apply it. */
const MODEL_SWITCH_NUDGE =
  "[System: your model was switched at your request; the previous turn was ended to " +
  "apply it. Continue where you left off on the new model — do NOT restart the task, " +
  "re-introduce yourself, or repeat anything you already did or posted.]";

/** The title a conversation is created with, before the agent's <title> marker names it. */
export const PLACEHOLDER_TITLE = "New chat";

/** Whether a title is still the create-time placeholder, i.e. the conversation is unnamed. */
export function isPlaceholderTitle(title: string | undefined): boolean {
  return (title ?? "").trim() === "" || title === PLACEHOLDER_TITLE;
}

/** An event plus the rolling integrity checksum before it (`prevChecksum`) and through it
 *  (`checksum`). */
export interface ChecksummedEvent {
  event: AguiEvent;
  prevChecksum: string;
  checksum: string;
}

/** Provisions, suspends, resumes and destroys the per-conversation Sandbox. */
export interface SandboxProvisioner {
  /** Cold-create a Sandbox named by the short DNS-1123-safe `conversationId`; `threadId` is the
   *  full conversation id used for its CONVERSATION_URL (defaults to `conversationId`). */
  create(conversationId: string, threadId?: string): Promise<SandboxRef>;
  /** Set operatingMode Suspended: drop the pod, keep the PVCs and the Sandbox object. */
  suspend(ref: SandboxRef): Promise<void>;
  /** Set operatingMode Running: recreate the pod and re-mount the PVCs. */
  resume(ref: SandboxRef, threadId?: string): Promise<SandboxRef>;
  /** Delete the Sandbox and GC its per-conversation SA/RBAC. */
  destroy(ref: SandboxRef): Promise<void>;
  /** List the live per-conversation Sandboxes with whether each pod is currently running, so
   *  hydrate() tracks still-running pods; optional. */
  reconcile?(): Promise<Array<{ ref: SandboxRef; running: boolean }>>;
}

/** Durable, restart-surviving metadata for one conversation. */
export interface ConversationMeta {
  id: SessionId;
  threadId: ThreadId;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  /** Per-conversation model override (undefined = host default). */
  model?: string;
  /** Creating user (ingress identity); undefined = unowned/public. */
  owner?: string;
  /** The spawning conversation when this is a subagent, which shares its parent's sandbox pod. */
  parentId?: SessionId;
  /** The user renamed this conversation, so the agent's <title> marker no longer overwrites
   *  `title`. */
  userTitled?: boolean;
  /** The user starred this conversation, which exempts it from retention reaping but not from
   *  idle-suspend. */
  starred?: boolean;
  /** Messages still queued in the bridge when the conversation was suspended; revive() re-enqueues
   *  them and clears the field. */
  pendingQueue?: Array<{ text: string; priority: number }>;
}

/** An external resource a conversation is linked to (GitHub PR/issue, GitLab MR, Slack thread, Jira
 *  ticket), pushed by the webhooks service and shown in the UI's linked-resources panel. */
export interface ConversationLink {
  /** "github" | "gitlab" | "slack" | "jira" | … (drives the icon). */
  source: string;
  /** "pull_request" | "issue" | "merge_request" | "thread" | "ticket" | … */
  resourceType: string;
  /** A clickable URL to the resource, when known. */
  url?: string;
  /** A short human label (e.g. "example-org/example-app #203", "#eng-help thread"). */
  title?: string;
  /**
   * Structured target identifiers the agent-tools use to infer where to respond, populated
   * by push_link: slack `{ channel, threadTs }`, gitlab `{ projectId, mrIid }` for a merge
   * request or `{ projectId, iid }` for an issue, github `{ owner, repo, number }`, jira
   * `{ issueKey }`.
   */
  ref?: {
    channel?: string;
    threadTs?: string;
    projectId?: string;
    mrIid?: string;
    iid?: string;
    owner?: string;
    repo?: string;
    number?: number;
    issueKey?: string;
  };
}

/** Durable conversation store: event-log replay plus the goose state pointer. */
export interface ConversationStore {
  appendEvent(id: SessionId, event: AguiEvent): Promise<void>;
  /** Await every append enqueued so far for `id` to be durably written, since appendEvent is
   *  fire-and-forget; optional. */
  flush?(id: SessionId): Promise<void>;
  readEvents(id: SessionId): AsyncIterable<AguiEvent>;
  /** Like readEvents, but each item carries the rolling integrity checksum computed from the
   *  persisted log order; optional. */
  readEventsWithChecksum?(id: SessionId): AsyncIterable<ChecksummedEvent>;
  /** Atomically replace a conversation's entire event log with `events`, resetting the rolling
   *  checksum; optional and reconciliation-only. */
  replaceEvents?(id: SessionId, events: AguiEvent[]): Promise<void>;
  /** The events of the last `runs` runs, read without parsing the whole log; optional. */
  readEventsTail?(id: SessionId, runs: number): Promise<AguiEvent[]>;
  /** The last `limit` events by seq; optional. */
  readEventsTailByCount?(id: SessionId, limit: number): Promise<AguiEvent[]>;
  readEventsBefore?(
    id: SessionId,
    beforeSeq: number,
    limit: number,
  ): Promise<{ events: AguiEvent[]; firstSeq: number; done: boolean }>;
  /** Subscribe to events as they are durably appended, each carrying its rolling checksum, and get
   *  back an unsubscribe fn; optional. */
  onAppend?(cb: (id: SessionId, event: ChecksummedEvent) => void): () => void;
  /** Subscribe to durable-append failures and get back an unsubscribe fn; optional. */
  onAppendError?(cb: (id: SessionId, error: unknown) => void): () => void;
  /** Path on the conversation-state PVC where goose session data lives. */
  gooseStatePath(id: SessionId): string;
  /** Persist conversation metadata so the list survives a restart; optional. */
  saveMeta?(meta: ConversationMeta): Promise<void>;
  /** Reconstruct all persisted conversations; optional. */
  listConversations?(): Promise<ConversationMeta[]>;
  /** Permanently remove a conversation's persisted state so it does not reappear on the next
   *  hydrate(); optional. */
  removeConversation?(id: SessionId): Promise<void>;
  /** Record an external resource link for a conversation (deduped); optional. */
  addLink?(id: SessionId, link: ConversationLink): Promise<void>;
  /** The conversation's external resource links; optional. */
  listLinks?(id: SessionId): Promise<ConversationLink[]>;
  /** Append a background-job record so list_background survives a restart; optional. */
  saveJob?(id: SessionId, job: JobRecord): Promise<void>;
  /** The conversation's background-job records (newest first; [] if none). */
  listJobs?(id: SessionId): Promise<JobRecord[]>;
  /** Update a job record in place by jobId; optional. */
  updateJob?(id: SessionId, job: JobRecord): Promise<void>;
}

/**
 * A prompt arrived for a conversation that does not exist. The agent-host never
 * creates one implicitly: conversations are created by the conversation-router
 * (services/conversation-router/create.go), so a caller-chosen id can never become
 * a conversation id, an event-log key, or a k8s resource name.
 */
export class UnknownConversationError extends Error {
  constructor(readonly threadId: string) {
    super(`unknown conversation: ${threadId}`);
    this.name = "UnknownConversationError";
  }
}

export type ConversationStatus = "running" | "suspended" | "ended";

export interface Conversation {
  readonly id: SessionId;
  readonly threadId: ThreadId;
  readonly sandbox: SandboxRef;
  readonly bridge?: SessionBridge;
  readonly status: ConversationStatus;
  readonly title: string;
  readonly createdAt: number;
  /** ms epoch of the last prompt or agent event; drives idle-suspend. */
  readonly lastActivityAt: number;
  /** Model this conversation runs on (undefined = the host default). */
  readonly model?: string;
  /** The user who created it (the ingress identity); undefined = unowned/public, and a view filter
   *  rather than an access boundary. */
  readonly owner?: string;
  /** The spawning conversation when this is a subagent; children are found by scanning for
   *  `parentId === id`. */
  readonly parentId?: SessionId;
  /** The title is user-set and locked against the agent's <title> marker. */
  readonly userTitled?: boolean;
  /** The user starred it. */
  readonly starred?: boolean;
}

export interface SessionManager {
  /** Start a brand-new conversation (cold Sandbox + goose + PVCs) on `model`, owned by `owner`. */
  start(threadId: ThreadId, model?: string, owner?: string): Promise<Conversation>;
  /** Spawn a subagent: a new conversation with its own bridge that shares the parent's sandbox pod,
   *  inherits its owner and carries `parentId`; throws if the parent is unknown. */
  spawnChild(
    parentId: SessionId,
    childThreadId: ThreadId,
    args: { prompt: string; title?: string; model?: string },
  ): Promise<Conversation>;
  /** Subscribe to subagent completions, fired as (subagentId, parentId) when a subagent's run
   *  finishes or errors (an interrupt pause does not count); returns an unsubscribe. */
  onSubagentComplete(cb: (subagentId: SessionId, parentId: SessionId) => void): () => void;
  /** Revive a suspended conversation already known to this pod: resume the sandbox and rebuild the
   *  bridge. */
  revive(id: SessionId): Promise<Conversation>;
  /** Revive a conversation this pod was just assigned, which may be unknown to it; idempotent, and
   *  a push whose `expectedGen` is stale is a no-op. */
  reviveFromMirror(id: SessionId, expectedGen: number): Promise<void>;
  /** Settle a conversation's dangling last run on this pod by terminating it (persisted cancel
   *  intent) or resume-nudging it; owner-fenced by callers, one reconciliation in flight per
   *  conversation. */
  reconcileDanglingRun(id: SessionId, expectedGen?: number): Promise<void>;
  /** Make a conversation's history readable on this pod without starting its sandbox or bridge;
   *  returns false when the conversation is genuinely unknown. */
  ensureReadable(id: SessionId): Promise<boolean>;
  /** Forward a user prompt into the conversation's goose session; a differing `model` rebuilds the
   *  session on the new model, and `priority` lets an @mention interrupt a running turn. */
  prompt(id: SessionId, text: string, model?: string, priority?: number, interrupt?: InterruptPolicy, images?: PromptImage[], files?: PromptFile[], source?: string): Promise<void>;
  /** Find-or-start the conversation for an AG-UI thread and prompt it, where `model` picks the
   *  conversation's model on the first prompt and switches it on a later one, `owner` stamps a
   *  conversation newly started here, and `images`/`files` are attachments the bridge resolves
   *  or writes to /workspace/uploads. */
  promptByThread(threadId: ThreadId, text: string, model?: string, priority?: number, owner?: string, images?: PromptImage[], files?: PromptFile[], source?: string, provider?: string): Promise<void>;
  /** Switch a running conversation's model mid-turn for the switch_model tool, cancelling the
   *  in-flight run, rebuilding goose on the new model and re-nudging it to continue; a no-op if
   *  `model` is current, throws on an unknown conversation, and returns whether a switch happened. */
  switchModelNow(id: SessionId, model: string): Promise<boolean>;
  suspend(id: SessionId): Promise<void>;
  end(id: SessionId): Promise<void>;

  get(id: SessionId): Conversation | undefined;
  /** Resolve a conversation by the short DNS-safe hash of its threadId (how the broker identifies
   *  it), hydrating a persisted one on demand. */
  getByShortId(shortHash: string): Promise<Conversation | undefined>;
  /** Mark a conversation active now so the idle sweep does not suspend it, for non-agent activity
   *  such as web-service proxy traffic; no-op if not in memory. */
  touchById(id: SessionId): void;
  /** All conversations, newest first. */
  list(): Conversation[];
  /** Set the title from the agent's <title> marker and return the persist promise; a no-op once the
   *  conversation is named, which `force` (a deliberate rename through set_conversation_title)
   *  overrides — a user rename locks the title against both. */
  setTitle(id: SessionId, title: string, opts?: { force?: boolean }): Promise<void>;
  /** Rename from the user: set the title and lock it against the agent's <title> marker. */
  setUserTitle(id: SessionId, title: string): Promise<void>;
  /** Star or unstar a conversation and persist it. */
  setStarred(id: SessionId, starred: boolean): Promise<void>;
  /** Load persisted conversations into the in-memory list after a restart; persisted-but-not-live
   *  ones come back as "suspended". */
  hydrate(): Promise<void>;
  /**
   * Revive each conversation whose last run was interrupted by a restart and send it a
   * continue nudge, with bounded concurrency; returns the ids resumed.
   */
  resumeInterrupted(opts?: { concurrency?: number }): Promise<SessionId[]>;
  /**
   * Suspend conversations idle longer than idleMs; returns the ids suspended.
   */
  sweepIdle(idleMs: number, now?: number): Promise<SessionId[]>;

  /**
   * Destructively end top-level conversations inactive longer than maxAgeMs, exempting
   * starred ones and those with a live descendant; returns the ids reaped.
   */
  sweepRetention(maxAgeMs: number, now?: number): Promise<SessionId[]>;
}

/** Builds the ACP<->AG-UI bridge for a conversation (spawns goose in prod). */
export type BridgeFactory = (args: {
  conversationId: SessionId;
  sandbox: SandboxRef;
  /** Per-conversation model override (undefined = host default). */
  model?: string;
  /** The explicitly picked provider, for the per-run resolver. */
  pickedProvider?: string;
  /** The conversation owner, passed to the bridge's per-run ACP provider resolver so an
   *  owner-bound provider (the BYO remote agent) can route this conversation to that user's
   *  agent; undefined for an unowned/anonymous conversation. */
  owner?: string;
}) => SessionBridge | undefined;

export interface SessionManagerDeps {
  provisioner: SandboxProvisioner;
  store: ConversationStore;
  /** Multi-replica fencing guard consulted before this pod appends to a conversation's log; omitted
   *  = allowAllGuard. */
  ownershipGuard?: OwnershipGuard;
  /** Multi-replica registry that writes a Conversation CR so the controller can assign a hostPod;
   *  omitted = noopRegistry. */
  conversationRegistry?: ConversationRegistry;
  /** This pod's name (POD_NAME); when set with a registry that can list(), hydrate() adopts every
   *  Conversation CR assigned to this pod. */
  selfPod?: string;
  /** How to build a bridge per conversation; omitted in lifecycle-only unit tests. */
  bridgeFactory?: BridgeFactory;
  /** Called with a live bridge after revive() rebuilds it, so the host can re-raise approval
   *  interrupts still pending in the broker; fire-and-forget. */
  onRevived?: (id: SessionId) => void;
  /** Whether the conversation has a running background job; sweepIdle consults it and fails open on
   *  a throw. */
  hasRunningBackgroundJob?: (id: SessionId) => Promise<boolean>;
}

interface Entry {
  id: SessionId;
  threadId: ThreadId;
  sandbox: SandboxRef;
  bridge?: SessionBridge;
  status: ConversationStatus;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  model?: string;
  /** The explicitly picked provider, persisted so a resume keeps the swap. */
  pickedProvider?: string;
  owner?: string;
  parentId?: SessionId;
  userTitled?: boolean;
  starred?: boolean;
  /** Messages still queued in the bridge when this conversation was suspended, for revive() to
   *  re-enqueue. */
  pendingQueue?: Array<{ text: string; priority: number }>;
}

/** Drain an async iterable of events into an array. */
async function collectEvents(it: AsyncIterable<AguiEvent>): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** Short, DNS-1123-safe id derived from a thread id; the key that sandboxes and broker-side
 *  per-conversation state share. */
export function shortId(threadId: string): string {
  let h = 0;
  for (let i = 0; i < threadId.length; i++) h = (h * 31 + threadId.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { provisioner, store, bridgeFactory } = deps;
  const ownershipGuard = deps.ownershipGuard ?? allowAllGuard;
  const conversationRegistry = deps.conversationRegistry ?? noopRegistry;
  const entries = new Map<SessionId, Entry>();

  // Fired when a subagent's bridge emits a terminal RUN_FINISHED/RUN_ERROR.
  const subagentCompleteSubs = new Set<(subagentId: SessionId, parentId: SessionId) => void>();
  const emitSubagentComplete = (subagentId: SessionId, parentId: SessionId): void => {
    for (const cb of subagentCompleteSubs) {
      try { cb(subagentId, parentId); } catch (err) {
        // eslint-disable-next-line no-console
        log.errorWith("onSubagentComplete listener threw", err, { subagent_id: subagentId });
      }
    }
  };

  const toConversation = (e: Entry): Conversation => ({
    id: e.id,
    threadId: e.threadId,
    sandbox: e.sandbox,
    bridge: e.bridge,
    status: e.status,
    title: e.title,
    createdAt: e.createdAt,
    lastActivityAt: e.lastActivityAt,
    model: e.model,
    owner: e.owner,
    parentId: e.parentId,
    userTitled: e.userTitled,
    starred: e.starred,
  });

  // Mark the conversation active now; fire-and-forget because it runs on the prompt path and proxy
  // traffic.
  const touch = (e: Entry) => {
    e.lastActivityAt = nowMs();
    void saveMeta(e);
  };

  // Build an in-memory Entry from a persisted meta, with no bridge; `onCluster` is the reconcile
  // result for its Sandbox.
  const hydrateEntry = (m: ConversationMeta, onCluster?: { ref: SandboxRef; running: boolean }): Entry => {
    const name = `conv-${shortId(m.threadId)}`;
    const entry: Entry = {
      id: m.id,
      threadId: m.threadId,
      // Keep the real ref for any Sandbox that exists on the cluster so revive() resumes it; the
      // empty-namespace placeholder tells revive() to create from scratch.
      sandbox: onCluster ? onCluster.ref : { name, namespace: "" },
      bridge: undefined,
      status: onCluster?.running ? "running" : "suspended",
      title: m.title,
      createdAt: m.createdAt,
      lastActivityAt: m.lastActivityAt,
      model: m.model,
      owner: m.owner,
      parentId: m.parentId,
      userTitled: m.userTitled,
      starred: m.starred,
      pendingQueue: m.pendingQueue,
    };
    entries.set(m.id, entry);
    return entry;
  };

  // On-demand hydration of one thread from the store or its Conversation CR; returns undefined when
  // neither has it or the store read fails.
  const hydrateByThread = async (threadId: ThreadId): Promise<Entry | undefined> => {
    let metas: ConversationMeta[];
    try {
      metas = (await store.listConversations?.()) ?? [];
    } catch (err) {
      // eslint-disable-next-line no-console
      log.errorWith("hydrateByThread store lookup failed; may create a duplicate", err, {
        conversation_id: threadId,
      });
      return undefined;
    }
    let m = metas.find((x) => x.threadId === threadId);
    const fromStore = m !== undefined;
    if (!m) {
      // The CR is authoritative for existence, so adopt from it when the store has no meta yet.
      const c = await conversationRegistry.get(threadId).catch(() => undefined);
      if (!c) return undefined;
      m = {
        id: c.id,
        threadId: c.id,
        title: "",
        createdAt: nowMs(),
        lastActivityAt: nowMs(),
        model: c.spec.model,
        owner: c.spec.owner,
        parentId: c.spec.parentId,
      };
      // Publish sandboxRef now so the router can derive the routing short-id before the sandbox
      // finishes booting.
      if (!c.spec.sandboxRef) {
        void conversationRegistry.register(c.id, {
          model: c.spec.model,
          owner: c.spec.owner,
          parentId: c.spec.parentId,
          sandboxRef: `conv-${shortId(c.id)}`,
          creatorPod: deps.selfPod, // placement hint for the controller
        });
      }
    }
    if (entries.has(m.id)) return entries.get(m.id);
    // Never re-adopt a conversation end() destroyed.
    if (endedIds.has(m.id)) return undefined;
    // Reconcile this conversation's Sandbox so a still-running pod is tracked; on failure revive()
    // recreates from the placeholder.
    let onCluster: { ref: SandboxRef; running: boolean } | undefined;
    try {
      const name = `conv-${shortId(m.threadId)}`;
      onCluster = (await provisioner.reconcile?.())?.find((s) => s.ref.name === name);
    } catch {
      /* treat as suspended */
    }
    const hydrated = hydrateEntry(m, onCluster);
    // Settle any stranded run on every adoption path; owner-fenced, fire-and-forget, deduped by the
    // in-flight guard.
    if (hydrated && ownershipGuard.canWrite(hydrated.id)) {
      void api.reconcileDanglingRun(hydrated.id);
      // Persist CR-synthesized metadata so the conversation list sees a conversation adopted but
      // never prompted.
      if (!fromStore) void saveMeta(hydrated);
    }
    return hydrated;
  };

  // Ids end() has torn down; a late write for one must never land, since it would resurrect the
  // conversation with a pod the delete was meant to reclaim.
  const endedIds = new Set<SessionId>();
  const ENDED_TOMBSTONES = 4096;
  const tombstone = (id: SessionId) => {
    // Bounded FIFO: Set preserves insertion order, so the first key is the oldest.
    if (endedIds.size >= ENDED_TOMBSTONES) {
      const oldest = endedIds.values().next();
      if (!oldest.done) endedIds.delete(oldest.value);
    }
    endedIds.add(id);
  };

  // Returns the persist promise so callers that need durability can await it.
  const saveMeta = (e: Entry): Promise<void> =>
    endedIds.has(e.id)
      ? Promise.resolve()
      : store.saveMeta?.({
          id: e.id,
          threadId: e.threadId,
          title: e.title,
          createdAt: e.createdAt,
          lastActivityAt: e.lastActivityAt,
          model: e.model,
          owner: e.owner,
          parentId: e.parentId,
          userTitled: e.userTitled,
          starred: e.starred,
          pendingQueue: e.pendingQueue,
        }) ?? Promise.resolve();

  /** Events dropped by the ownership fence, per conversation — for sampled logging only. */
  const fencedDrops = new Map<SessionId, number>();
  /** Dangling-run reconciliations in flight, so racing callers settle each conversation once. */
  const danglingReconciles = new Set<SessionId>();
  const wireEventLog = (e: Entry) => {
    if (!e.bridge) return;
    // Persist via onPersist only: it sees every event that should be logged exactly once, while
    // onEvent would double-log broadcasts.
    e.bridge.onPersist((event) => {
      e.lastActivityAt = nowMs();
      // Cheap synchronous pre-filter; the store's AppendFence is the authority.
      if (!ownershipGuard.canWrite(e.id)) {
        // Warn, sampled (first drop, then every 25th), because this drop is how a mid-run
        // reassignment truncates the run's log.
        const n = (fencedDrops.get(e.id) ?? 0) + 1;
        fencedDrops.set(e.id, n);
        if (n === 1 || n % 25 === 0) {
          log.warn("ownership fence dropped an event (reassigned mid-run?)", {
            conversation_id: e.id,
            event_type: event.type,
            dropped_so_far: n,
          });
        }
        return;
      }
      // Not bare `void`: the store rethrows append failures after logging them, and an unhandled
      // rejection would kill the process.
      store.appendEvent(e.id, event).catch(() => {});
    });
  };

  /** Switch a conversation's model: update entry.model, tear down the live bridge fire-and-forget
   *  so the next prompt's revive relaunches goose with the new GOOSE_MODEL, and persist the
   *  change; a no-op when `model` is undefined or already current. */
  const applyModelSwitch = async (e: Entry, model?: string, provider?: string): Promise<void> => {
    // A provider-only switch must rebuild too: `model` has not moved.
    const providerMoved = provider !== undefined && provider !== e.pickedProvider;
    if ((model === undefined || model === e.model) && !providerMoved) return;
    if (model !== undefined) e.model = model;
    if (provider !== undefined) e.pickedProvider = provider;
    if (e.bridge) {
      const old = e.bridge;
      e.bridge = undefined; // the next revive rebuilds with e.model
      // Fire-and-forget: don't block the next prompt on the old goose's exit.
      void old.stop().catch(() => {});
    }
    await saveMeta(e);
  };

  const api: SessionManager = {
    async start(threadId, model, owner) {
      // The conversation id is the thread id; the k8s name is a short hash of it.
      const id: SessionId = threadId;
      // Register the entry before the slow provisioning so the UI's immediate events.integrity GET
      // does not 404.
      const entry: Entry = {
        id, threadId, sandbox: { name: `conv-${shortId(threadId)}`, namespace: "" },
        bridge: undefined, status: "running",
        title: PLACEHOLDER_TITLE, createdAt: nowMs(), lastActivityAt: nowMs(), model, owner,
      };
      entries.set(id, entry);
      await saveMeta(entry);

      // Register the CR before provisioning so the controller can assign a hostPod while the
      // sandbox spins up; idempotent and non-throwing.
      await conversationRegistry.register(id, { model, owner, sandboxRef: entry.sandbox.name, creatorPod: deps.selfPod });

      // Provision the sandbox and attach the bridge.
      entry.sandbox = await provisioner.create(shortId(threadId), threadId);
      entry.bridge = bridgeFactory?.({ conversationId: id, sandbox: entry.sandbox, model, owner: entry.owner });
      wireEventLog(entry); // after the bridge exists
      // Re-persist with the real sandbox ref so a crash mid-provision leaves a resumable entry.
      await saveMeta(entry);
      // bridge.prompt() lazily starts goose on first use, after emitting RUN_STARTED.
      return toConversation(entry);
    },

    async spawnChild(parentId, childThreadId, args) {
      const parent = entries.get(parentId);
      if (!parent) throw new Error(`unknown parent conversation: ${parentId}`);
      const id: SessionId = childThreadId;
      // A subagent shares the parent's sandbox pod, inherits its owner and carries parentId; its
      // bridge execs into the parent's pod with its own goose session.
      const model = args.model ?? parent.model;
      const entry: Entry = {
        id,
        threadId: childThreadId,
        sandbox: parent.sandbox, // shared, no provisioner.create
        bridge: undefined,
        status: "running",
        title: args.title ?? "Subagent",
        createdAt: nowMs(),
        lastActivityAt: nowMs(),
        model,
        owner: parent.owner,
        parentId,
      };
      entries.set(id, entry);
      await saveMeta(entry);

      // Register the child CR with parentId so the controller co-locates it on the parent's pod.
      await conversationRegistry.register(id, {
        model, owner: parent.owner, parentId, sandboxRef: entry.sandbox.name,
        creatorPod: deps.selfPod, // placement hint for the controller
      });

      entry.bridge = bridgeFactory?.({ conversationId: id, sandbox: entry.sandbox, model, owner: entry.owner });
      wireEventLog(entry);
      // Fire onSubagentComplete when this subagent's run terminates; a RUN_FINISHED with outcome
      // "interrupt" is a pause, not a completion.
      entry.bridge?.onEvent((event) => {
        const done =
          (event.type === "RUN_FINISHED" && event.outcome?.type !== "interrupt") || event.type === "RUN_ERROR";
        if (done) emitSubagentComplete(id, parentId);
      });
      await saveMeta(entry);

      // Frame the prompt so the subagent ends its turn with a summary, which is what returns to the
      // parent.
      const framedPrompt =
        `${args.prompt}\n\n` +
        `---\n(You are a subagent. Do the task above, then END your turn with a ` +
        `concise summary of what you found or did — that final message is returned ` +
        `to the agent that spawned you.)`;
      // Fire-and-forget: prompt() resolves on run completion, and the parent is told via
      // onSubagentComplete.
      void entry.bridge?.prompt({ threadId: childThreadId, text: framedPrompt }).catch((err: unknown) => {
        log.errorWith("subagent initial prompt failed", err, { conversation_id: id, parent_id: parentId });
      });
      return toConversation(entry);
    },

    async revive(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      // A tombstoned entry may still be held by a caller that raced the delete.
      if (endedIds.has(id)) throw new Error(`conversation was ended: ${id}`);

      // A placeholder ref with no namespace means the Sandbox is absent, so create rather than
      // resume.
      entry.sandbox = entry.sandbox.namespace
        ? await provisioner.resume(entry.sandbox, entry.threadId)
        : await provisioner.create(shortId(entry.threadId), entry.threadId);
      // end() may have landed during provisioning; destroy the pod just made before any side effect
      // re-creates the CR.
      if (endedIds.has(id)) {
        await provisioner.destroy(entry.sandbox).catch((err: unknown) => {
          log.errorWith("failed to destroy a pod revived into a deleted conversation", err, {
            conversation_id: id,
          });
        });
        throw new Error(`conversation was ended: ${id}`);
      }
      entry.bridge = bridgeFactory?.({ conversationId: id, sandbox: entry.sandbox, model: entry.model, pickedProvider: entry.pickedProvider, owner: entry.owner }) ?? entry.bridge;
      entry.status = "running";
      // Re-register the CR so a conversation whose CR was never created or was lost becomes
      // routable again; idempotent, fire-and-forget.
      void conversationRegistry.register(id, {
        model: entry.model, owner: entry.owner, parentId: entry.parentId, sandboxRef: entry.sandbox.name,
        creatorPod: deps.selfPod, // placement hint for the controller
      });
      // Count the resume as activity so the idle sweep gives the fresh pod a full idle window; set
      // directly rather than touch() so no fire-and-forget saveMeta races the awaited write below.
      entry.lastActivityAt = nowMs();
      wireEventLog(entry);
      await saveMeta(entry); // awaited so a persist failure propagates
      await entry.bridge?.start();
      // Re-raise interrupts the previous pod lost; fire-and-forget.
      if (entry.bridge) {
        try {
          deps.onRevived?.(id);
        } catch (err) {
          log.errorWith("onRevived hook failed", err, { conversation_id: id });
        }
      }
      // Re-enqueue the messages suspend() drained; clear and persist the field first so a failure
      // cannot replay them twice.
      let pending = entry.pendingQueue ?? [];
      if (pending.length > 0) {
        // Skip messages already in the durable log: runPrompt persists the user message before
        // calling the agent, so an in-flight message would otherwise run twice.
        try {
          const tail = (await store.readEventsTail?.(id, 3)) ?? (await collectEvents(store.readEvents(id)));
          // Match only user turns: TEXT_MESSAGE_CONTENT carries no role, and an assistant reply
          // quoting the text must not suppress a replay.
          const userMsgIds = new Set<string>();
          const loggedUserTexts = new Set<string>();
          for (const e of tail) {
            const ev = e as { type?: string; delta?: string; role?: string; messageId?: string };
            if (ev.type === "TEXT_MESSAGE_START" && ev.role === "user" && ev.messageId) {
              userMsgIds.add(ev.messageId);
            } else if (
              ev.type === "TEXT_MESSAGE_CONTENT" &&
              typeof ev.delta === "string" &&
              ev.messageId !== undefined &&
              userMsgIds.has(ev.messageId)
            ) {
              loggedUserTexts.add(ev.delta);
            }
          }
          const before = pending.length;
          pending = pending.filter((p) => !loggedUserTexts.has(p.text));
          if (pending.length !== before) {
            log.warn("revive: skipping already-logged messages (in-flight replay dedupe)", {
              conversation_id: id,
              skipped: before - pending.length,
            });
          }
        } catch (err) {
          // Replaying is the safer default on a read failure: a possible duplicate turn beats
          // dropping the user's message.
          log.errorWith("revive: replay dedupe read failed, replaying all", err, { conversation_id: id });
        }
      }
      if (pending.length > 0 || (entry.pendingQueue?.length ?? 0) > 0) {
        entry.pendingQueue = [];
        await saveMeta(entry);
        for (const item of pending) {
          // A queued message that fails to re-run must not fail the revive.
          void entry.bridge
            ?.prompt(
              { threadId: entry.threadId, text: item.text },
              item.priority ? { priority: item.priority } : undefined,
            )
            .catch((err) => {
              log.errorWith("re-enqueued message failed", err, { conversation_id: id });
            });
        }
      }
      // Publish phase=Assigned; owner-fenced, fire-and-forget.
      if (ownershipGuard.canWrite(id)) void conversationRegistry.setPhase(id, "Assigned");
      return toConversation(entry);
    },

    async reviveFromMirror(id, expectedGen) {
      // The controller pushes this on a conversation's new host right after assigning it.

      // A positive "another pod owns it" verdict can be a stale cache, since the controller pushes
      // right after writing hostPod and the watch event often lands later: a push whose generation
      // is newer than anything observed is trusted and adopted, while one at or below the observed
      // generation is fenced out loudly.
      if (!ownershipGuard.canWrite(id)) {
        const observed = ownershipGuard.observedGeneration?.(id);
        const pushIsNewer =
          expectedGen > 0 && (observed === undefined || expectedGen > observed);
        if (!pushIsNewer || !ownershipGuard.adoptAssignment) {
          log.warn("reviveFromMirror: fenced out (another pod owns this conversation)", {
            conversation_id: id,
            observed_generation: observed ?? null,
            pushed_generation: expectedGen,
          });
          return; // a genuinely stale push
        }
        ownershipGuard.adoptAssignment(id, expectedGen);
        log.info("reviveFromMirror: push is ahead of the CR watch — adopting the assignment", {
          conversation_id: id,
          observed_generation: observed ?? null,
          pushed_generation: expectedGen,
        });
      }

      // Hydrate and revive if not already in memory; the dangling-run settlement below runs either
      // way.
      if (!entries.get(id)) {
        const entry = await hydrateByThread(id as ThreadId);
        if (!entry) {
          // Giving up means nobody completes the conversation's run, so warn.
          log.warn("reviveFromMirror: could not reconstruct the conversation", {
            conversation_id: id,
          });
          return;
        }
        void expectedGen; // enforced by the fence above and the append guard
        await this.revive(id);
      }

      // A conversation reassigned mid-run has an unfinished last run; re-drive it so it completes
      // on this host.
      await this.reconcileDanglingRun(id, expectedGen);
    },

    async reconcileDanglingRun(id, expectedGen) {
      if (danglingReconciles.has(id)) return; // one settlement at a time
      danglingReconciles.add(id);
      try {
        // A run this pod started at this generation is in flight, not stranded; without a gen (lazy
        // adoption) a same-host run is left alone.
        const self = deps.selfPod ? { host: deps.selfPod, gen: expectedGen } : undefined;
        const events = await collectEvents(store.readEvents(id));

        // Close every run left open anywhere in the log, not just at the tail, since a fenced
        // hand-off can bury an orphan under later turns; `self` keeps our own live run out of the
        // sweep.
        const inFlight = danglingRunInfo(events, self)?.runId;
        const orphans = orphanRuns(events, self).filter((o) => o.runId !== inFlight);
        for (const o of orphans) {
          await store.appendEvent(id as SessionId, {
            type: "RUN_FINISHED",
            threadId: o.threadId as never,
            runId: o.runId as never,
            interrupted: true,
            ts: Date.now(),
          });
        }
        if (orphans.length > 0) {
          log.warn("closed runs left open by a hand-off", {
            conversation_id: id,
            closed: orphans.length,
            run_ids: orphans.map((o) => o.runId),
          });
        }

        const dangling = danglingRunInfo(events, self);
        if (!dangling) {
          // Logged so a no-op is distinguishable from the hook not firing.
          log.info("dangling-run check: nothing to settle", {
            conversation_id: id,
            events_seen: events.length,
          });
        }
        if (dangling?.cancelRequested) {
          // The user stopped this run before the old host died, so end it rather than resume it.
          log.info("dangling run was cancelled — terminating, not resuming", {
            conversation_id: id,
            run_id: dangling.runId,
          });
          await store.appendEvent(id as SessionId, {
            type: "RUN_FINISHED",
            threadId: dangling.threadId as never,
            runId: dangling.runId as never,
            cancelled: true,
            ts: Date.now(),
          });
        } else if (dangling) {
          log.info("resuming a dangling run", { conversation_id: id });
          // source "resume" persists as a UI-hidden SYSTEM_MESSAGE.
          void this.prompt(id, RESUME_NUDGE, undefined, undefined, undefined, undefined, undefined, "resume").catch((err) =>
            log.errorWith("dangling-run resume failed", err, { conversation_id: id }),
          );
        }
      } catch (err) {
        log.errorWith("dangling-run check failed", err, { conversation_id: id });
      } finally {
        danglingReconciles.delete(id);
      }
    },

    async ensureReadable(id) {
      const known = entries.get(id) !== undefined;
      // Read-only: hydrateByThread registers a suspended placeholder without starting the sandbox
      // or bridge.
      if (known) return true;
      const entry = await hydrateByThread(id as ThreadId);
      return entry !== undefined;
    },

    async prompt(id, text, model, priority, interrupt, images, files, source) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      touch(entry);
      await applyModelSwitch(entry, model);
      // Revive whenever there is no live bridge, since a hydrated conversation can be "running"
      // with no bridge in this process.
      if (!entry.bridge) await this.revive(id);
      const opts = priority || interrupt ? { priority, interrupt } : undefined;
      await entry.bridge?.prompt({ threadId: entry.threadId, text, images, files, source }, opts);
    },

    async promptByThread(threadId, text, model, priority, owner, images, files, source, provider) {
      // Find the conversation for this thread: in memory (revive if no live bridge), persisted
      // but not in memory (hydrate on demand and revive so a follow-up continues the existing
      // conversation), or genuinely new (start one, with the first prompt's model picking the
      // conversation's model).
      let entry = [...entries.values()].find((e) => e.threadId === threadId);
      if (!entry) {
        entry = await hydrateByThread(threadId);
      }
      if (!entry) {
        // Callers create explicitly via the router and prompt the id returned.
        throw new UnknownConversationError(threadId);
      } else {
        await applyModelSwitch(entry, model, provider);
        if (!entry.bridge) {
          // No live bridge, so revive.
          await this.revive(entry.id);
        }
      }
      touch(entry);
      // A priority prompt (a webhook @mention, or a send while a run is in flight) preempts
      // with the "thinking" policy: it ends the turn at its next tool-call boundary rather
      // than killing a tool call or discarding a turn that has not reached one. Why: PR #765.
      await entry.bridge?.prompt(
        { threadId, text, images, files, source },
        priority ? { priority, interrupt: "thinking" } : undefined,
      );
    },

    async switchModelNow(id, model) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      if (model === entry.model) return false; // already current
      touch(entry);
      // Called mid-turn by the switch_model tool: cancel the in-flight run cleanly, switch the
      // model on the now-idle bridge, then nudge only after the rebuild so the new goose is fully
      // up first.
      await entry.bridge?.cancel().catch(() => {});
      await applyModelSwitch(entry, model);
      // source "resume" persists as a UI-hidden SYSTEM_MESSAGE.
      await this.prompt(id, MODEL_SWITCH_NUDGE, undefined, undefined, undefined, undefined, undefined, "resume");
      return true;
    },

    async suspend(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      // Drain the bridge's in-memory queue onto the entry before dropping the bridge so
      // already-sent messages survive; the optional call keeps a bridge without drainQueue from
      // failing the suspend.
      const drained = entry.bridge?.drainQueue?.() ?? [];
      if (drained.length > 0) {
        entry.pendingQueue = [...(entry.pendingQueue ?? []), ...drained];
        await saveMeta(entry); // durable before the teardown
      }
      await entry.bridge?.stop();
      await provisioner.suspend(entry.sandbox);
      entry.bridge = undefined;
      entry.status = "suspended";
      // Publish phase to the CR; owner-fenced, fire-and-forget.
      if (ownershipGuard.canWrite(id)) void conversationRegistry.setPhase(id, "Suspended");
    },

    async end(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      // End the whole subtree depth-first; only the root of the end destroys the shared pod.
      const endSubtree = async (targetId: SessionId, destroyPod: boolean): Promise<void> => {
        const e = entries.get(targetId);
        if (!e) return;
        // Tombstone before the teardown's awaits so a concurrent prompt/revive cannot write the
        // conversation back.
        tombstone(targetId);
        // Depth-first: end descendants before this node.
        const children = [...entries.values()].filter((c) => c.parentId === targetId);
        for (const child of children) await endSubtree(child.id, false);
        await e.bridge?.stop();
        if (destroyPod) await provisioner.destroy(e.sandbox);
        e.bridge = undefined;
        e.status = "ended";
        // Drop from memory and persisted state so it neither lists nor returns on the next
        // hydrate().
        entries.delete(targetId);
        await store.removeConversation?.(targetId);
        // The CR is the source of truth for existence, so remove it too; a failure is logged rather
        // than failing a delete that already succeeded locally.
        await conversationRegistry.remove(targetId).catch((err: unknown) => {
          log.errorWith("failed to remove the Conversation CR; it may be re-adopted", err, {
            conversation_id: targetId,
          });
        });
      };
      // Only a top-level conversation owns its pod; a subagent shares its ancestor's.
      await endSubtree(id, entry.parentId === undefined);
    },

    get(id) {
      const entry = entries.get(id);
      return entry ? toConversation(entry) : undefined;
    },

    touchById(id) {
      const entry = entries.get(id);
      if (entry) touch(entry); // no-op if not in memory
    },

    async getByShortId(shortHash) {
      // In-memory first.
      const live = [...entries.values()].find((e) => shortId(e.threadId) === shortHash);
      if (live) return toConversation(live);
      // Not in memory: scan the persisted conversations and hydrate the match on demand.
      let metas: ConversationMeta[];
      try {
        metas = (await store.listConversations?.()) ?? [];
      } catch (err) {
        // eslint-disable-next-line no-console
        log.errorWith("getByShortId store lookup failed", err, { short_id: shortHash });
        return undefined;
      }
      const m = metas.find((x) => shortId(x.threadId) === shortHash);
      if (!m) return undefined;
      const entry = (await hydrateByThread(m.threadId)) ?? entries.get(m.id);
      return entry ? toConversation(entry) : undefined;
    },

    list() {
      return [...entries.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(toConversation);
    },

    setTitle(id, title, opts) {
      const entry = entries.get(id);
      if (!entry) return Promise.resolve();
      const force = opts?.force === true;
      // A user-chosen name is locked against the agent, force or not.
      if (entry.userTitled) return Promise.resolve();
      // A conversation is named only once; `force` is the deliberate rename.
      if (!force && !isPlaceholderTitle(entry.title)) return Promise.resolve();
      entry.title = title;
      // The durable write drives the live sidebar: the conversations row's trigger fires NOTIFY and
      // the conversation-router pushes the upsert.
      return saveMeta(entry);
    },

    setUserTitle(id, title) {
      const entry = entries.get(id);
      if (!entry) return Promise.resolve();
      entry.title = title;
      entry.userTitled = true; // lock it against the agent's <title>
      return saveMeta(entry);
    },

    setStarred(id, starred) {
      const entry = entries.get(id);
      if (!entry) return Promise.resolve();
      entry.starred = starred;
      return saveMeta(entry);
    },

    async hydrate() {
      const metas = (await store.listConversations?.()) ?? [];

      // The Conversation CR is the source of truth for which conversations this pod serves, and
      // `metas` is only the local cache; list() throws on failure and is left to propagate so a pod
      // that cannot read the truth does not serve a stale view.
      const crs = deps.selfPod ? await conversationRegistry.list() : [];
      // Adopt only what the controller assigned to us; an unassigned CR is left to the controller,
      // the single assigner.
      const mine = crs.filter((c) => c.hostPod && c.hostPod === deps.selfPod);
      const metaById = new Map(metas.map((m) => [m.id, m] as const));

      // Reconcile which conv-* Sandboxes exist and whether each pod runs, with retry and backoff to
      // ride out a boot-time apiserver blip; on exhaustion assume all suspended.
      const live = new Map<string, { ref: SandboxRef; running: boolean }>();
      let reconciled = false;
      const RETRIES = 5;
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        try {
          for (const s of (await provisioner.reconcile?.()) ?? []) {
            live.set(s.ref.name, s);
          }
          reconciled = true;
          break;
        } catch (err) {
          if (attempt === RETRIES - 1) {
            // Exhausted retries: assume suspended and log loudly.
            // eslint-disable-next-line no-console
            log.errorWith(
              "hydrate reconcile failed; assuming all suspended (pod-leak risk if persistent)",
              err,
              { attempts: RETRIES },
            );
          } else {
            // Exponential backoff.
            const delay = 250 * 2 ** attempt;
            // eslint-disable-next-line no-console
            log.warn("hydrate reconcile attempt failed; retrying", {
              attempt: attempt + 1,
              attempts: RETRIES,
              retry_in_ms: delay,
              error: formatError(err),
            });
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      void reconciled; // the fallback path already logged

      for (const m of metas) {
        if (entries.has(m.id)) continue; // a live one already exists
        const name = `conv-${shortId(m.threadId)}`;
        const entry = hydrateEntry(m, live.get(name));
        // Re-register the CR so every persisted conversation is observable and routable;
        // idempotent, fire-and-forget.
        void conversationRegistry.register(entry.id, {
          model: entry.model, owner: entry.owner, parentId: entry.parentId, sandboxRef: entry.sandbox.name,
          creatorPod: deps.selfPod, // placement hint for the controller
        });
        // Re-publish Suspended so a phase that never landed self-heals here, the one place a pod
        // re-observes a suspended conversation; owner-fenced.
        if (entry.status === "suspended" && ownershipGuard.canWrite(entry.id)) {
          void conversationRegistry.setPhase(entry.id, "Suspended");
        }
      }

      // Adopt the conversations the CR says are ours but the local cache never had.
      for (const c of mine) {
        if (entries.has(c.id)) continue; // already live or hydrated from the local cache
        // A conversation with no meta is adopted from the CR alone, enough to be listed, suspended
        // and reclaimed.
        const meta = metaById.get(c.id);
        const synthesized: ConversationMeta = meta ?? {
          id: c.id,
          threadId: c.id,
          title: "",
          createdAt: nowMs(),
          lastActivityAt: nowMs(),
          // status lives on Entry, derived by hydrateEntry() from the reconcile result
          model: c.spec.model,
          owner: c.spec.owner,
          parentId: c.spec.parentId,
        };
        // The CR's spec is authoritative over a possibly stale local meta.
        if (c.spec.owner) synthesized.owner = c.spec.owner;
        if (c.spec.model) synthesized.model = c.spec.model;
        // Key the reconcile result by the CR's sandboxRef when it has one.
        const sandboxName = c.spec.sandboxRef ?? `conv-${shortId(synthesized.threadId)}`;
        const entry = hydrateEntry(synthesized, live.get(sandboxName));
        entries.set(c.id, entry);
      }
    },

    async resumeInterrupted(opts) {
      const concurrency = Math.max(1, opts?.concurrency ?? 3);
      // Find conversations whose last run is dangling.
      const candidates: SessionId[] = [];
      for (const entry of entries.values()) {
        if (entry.status === "ended") continue;
        try {
          const events = await collectEvents(store.readEvents(entry.id));
          // No `self`: at boot every RUN_STARTED in the log predates this process, even one stamped
          // with our own pod name.
          const info = danglingRunInfo(events);
          if (info?.cancelRequested) {
            // Stopped by the user before the previous process died, so end it rather than redo it.
            log.info("resumeInterrupted: dangling run was cancelled — terminating", {
              conversation_id: entry.id,
              run_id: info.runId,
            });
            await store.appendEvent(entry.id, {
              type: "RUN_FINISHED",
              threadId: info.threadId as never,
              runId: info.runId as never,
              cancelled: true,
              ts: Date.now(),
            });
          } else if (info) {
            candidates.push(entry.id);
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          log.errorWith("resumeInterrupted: reading the log failed, skipping", err, {
            conversation_id: entry.id,
          });
        }
      }
      if (candidates.length === 0) return [];
      // eslint-disable-next-line no-console
      log.info("resuming interrupted conversations after restart", { count: candidates.length });

      // Bounded concurrency so a cold start does not spawn every goose at once.
      const resumed: SessionId[] = [];
      const queue = [...candidates];
      const worker = async () => {
        for (;;) {
          const id = queue.shift();
          if (!id) return;
          try {
            // source "resume" persists as a UI-hidden SYSTEM_MESSAGE.
            await this.prompt(id, RESUME_NUDGE, undefined, undefined, undefined, undefined, undefined, "resume");
            resumed.push(id);
          } catch (err) {
            // eslint-disable-next-line no-console
            log.errorWith("resumeInterrupted: resume failed", err, { conversation_id: id });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
      return resumed;
    },

    async sweepIdle(idleMs, now = nowMs()) {
      const suspended: SessionId[] = [];
      // A conversation with any non-terminal descendant must not be swept, since its subagents
      // share the pod.
      const hasLiveDescendant = (id: SessionId): boolean => {
        for (const c of entries.values()) {
          if (c.parentId !== id) continue;
          if (c.status !== "ended") return true; // a live child
          if (hasLiveDescendant(c.id)) return true; // ...or a live grandchild
        }
        return false;
      };
      for (const entry of entries.values()) {
        if (entry.status !== "running") continue;
        // Only the owner sweeps and probes; a non-owner's job probe can resume a sandbox the owner
        // just suspended.
        if (!ownershipGuard.canWrite(entry.id)) continue;
        if (now - entry.lastActivityAt < idleMs) continue;
        if (hasLiveDescendant(entry.id)) continue; // keep the shared pod up
        // A running or queued run is not idle, however long ago lastActivityAt was bumped at the
        // prompt boundary.
        const qs = entry.bridge?.queueState();
        if (qs && (qs.running || qs.queued > 0)) continue;
        // A running background job is not idle either; the probe fails open so an error cannot pin
        // the pod up forever.
        if (deps.hasRunningBackgroundJob) {
          let jobRunning = false;
          try {
            jobRunning = await deps.hasRunningBackgroundJob(entry.id);
          } catch (err) {
            log.errorWith("background-job check failed; suspending anyway", err, {
              conversation_id: entry.id,
            });
          }
          if (jobRunning) continue;
        }
        try {
          await this.suspend(entry.id);
          suspended.push(entry.id);
        } catch (err) {
          // Logged so a chronically unsuspendable conversation is visible.
          // eslint-disable-next-line no-console
          log.errorWith("idle-suspend failed; will retry next sweep", err, { conversation_id: entry.id });
        }
      }
      return suspended;
    },

    async sweepRetention(maxAgeMs, now = nowMs()) {
      const reaped: SessionId[] = [];
      // Same shared-pod guard as sweepIdle; subagents are reaped with their parent via end()'s
      // cascade.
      const hasLiveDescendant = (id: SessionId): boolean => {
        for (const c of entries.values()) {
          if (c.parentId !== id) continue;
          if (c.status !== "ended") return true;
          if (hasLiveDescendant(c.id)) return true;
        }
        return false;
      };
      // Snapshot first, since end() mutates `entries`.
      const candidates = [...entries.values()].filter((entry) => {
        if (entry.parentId !== undefined) return false; // subagents die with their parent
        if (entry.starred) return false; // starred = exempt
        if (now - entry.lastActivityAt < maxAgeMs) return false; // still recent
        if (hasLiveDescendant(entry.id)) return false; // keep the shared pod
        // Never reap a conversation with a live or queued run, since end() is destructive.
        const qs = entry.bridge?.queueState();
        if (qs && (qs.running || qs.queued > 0)) return false;
        return true;
      });
      for (const entry of candidates) {
        try {
          await this.end(entry.id);
          reaped.push(entry.id);
        } catch (err) {
          // Logged so a conversation that can never be reaped is visible.
          // eslint-disable-next-line no-console
          log.errorWith("retention reap failed; will retry next sweep", err, { conversation_id: entry.id });
        }
      }
      return reaped;
    },

    onSubagentComplete(cb) {
      subagentCompleteSubs.add(cb);
      return () => subagentCompleteSubs.delete(cb);
    },
  };
  return api;
}

/** Wall-clock ms, wrapped so it is mockable. */
function nowMs(): number {
  return Date.now();
}
