/**
 * ConversationRegistry: the multi-replica assignment table. The Conversation CR
 * (scooter.chadac.dev/v1alpha1) is the source of truth for a conversation's existence,
 * ownership and liveness; the local store, the in-memory entries and the Sandbox are
 * caches or bodies of it. The agent-host registers a CR when it starts a conversation,
 * the controller assigns it a hostPod, the router forwards on that, and the
 * OwnershipGuard fences stale writers by it. Single-replica agent-host (POD_NAME unset)
 * uses noopRegistry.
 */

export interface ConversationSpec {
  /** The model the conversation runs (mirrors Conversation.spec.model). */
  model?: string;
  /** Owning user id, or undefined for anonymous/single-user (spec.owner). */
  owner?: string;
  /** Parent conversation id for a subagent, else undefined (spec.parentId). */
  parentId?: string;
  /** The backing Sandbox name, if known at start (spec.sandboxRef). */
  sandboxRef?: string;
  /** The pod that created the conversation (spec.creatorPod), a placement hint the controller
   *  prefers while that pod is ready, since the run physically lives there. */
  creatorPod?: string;
}

/** Conversation liveness folded into the CR's `status.phase`: the controller owns the assignment
 *  phases, and agent-host publishes Suspended on idle-suspend and Assigned (alive) again on revive. */
export type ConversationPhase = "Assigned" | "Suspended";

export interface ConversationRegistry {
  /**
   * Ensure a `Conversation` CR exists for `id`; idempotent and never throws, so the
   * conversation still starts when the k8s write fails.
   */
  register(id: string, spec: ConversationSpec): Promise<void>;
  /**
   * Publish a liveness transition to `status.phase` for a conversation this pod owns;
   * idempotent, never throws, a no-op single-replica.
   */
  setPhase(id: string, phase: ConversationPhase): Promise<void>;

  /**
   * Delete the `Conversation` CR, since a surviving CR would be re-adopted by hydrate();
   * idempotent and never throws, but a failure is logged.
   */
  remove(id: string): Promise<void>;

  /**
   * List every Conversation CR in the namespace, the authoritative answer to which
   * conversations exist; callers filter to what they own, and unlike the write methods this
   * throws on failure so a pod cannot serve a stale view.
   */
  list(): Promise<ConversationRecord[]>;

  /**
   * One CR, or undefined when it does not exist; throws on a real k8s failure.
   */
  get(id: string): Promise<ConversationRecord | undefined>;

  /**
   * The conversations ROW's assignment (the source of truth the append fence checks), which
   * leads the CR mirror; undefined when there is no row. Optional: only the row-backed registry has it.
   */
  rowAssignment?(id: string): Promise<{ hostPod: string | null; generation: number } | undefined>;
}

/**
 * A Conversation CR as the host reads it: the spec plus the controller-owned status, enough
 * to rebuild an in-memory entry.
 */
export interface ConversationRecord {
  id: string;
  spec: ConversationSpec;
  /** status.phase, absent on a CR the controller has not reconciled yet. */
  phase?: ConversationPhase;
  /** status.hostPod, the pod the controller assigned; ownership is `hostPod === selfPod`. */
  hostPod?: string;
  /** status.hostIP, the routing address the router proxies to. */
  hostIP?: string;
  /** status.generation, bumped on reassignment; the fencing token for stale writers. */
  generation?: number;
}

/** The single-replica / test default: registering a conversation does nothing. */
export const noopRegistry: ConversationRegistry = {
  async register() {
    /* no CR in single-replica mode */
  },
  async setPhase() {
    /* no CR in single-replica mode */
  },
  async remove() {
    /* no CR in single-replica mode */
  },
  async list() {
    // Single-replica has no CRs, so [] keeps the CR-driven hydrate path a no-op.
    return [];
  },
  async get() {
    return undefined;
  },
};
