/**
 * OwnershipGuard: the cheap half of multi-replica fencing. Before this pod appends to a
 * conversation's durable log it checks that it is the owner (status.hostPod on the
 * Conversation CR) at the generation it was assigned under, so a pod reassigned away
 * skips the write. canWrite() is synchronous and does no k8s I/O, reading a cached view
 * kept fresh by a watch (k8sOwnershipGuard), because appendEvent fires once per streamed
 * token. It is a pre-filter, not the authority: the conversations row decides inside the
 * append statement (eventStore's AppendFence), so a stale cache costs a refused statement,
 * never a corrupted log.
 */

import type { SessionId } from "../types.js";

export interface OwnershipGuard {
  /** Whether this pod may append to `id`'s log right now; fails open when the conversation is not
   *  yet in the cache. */
  canWrite(id: SessionId): boolean;
  /** The generation of the cached assignment for `id` (undefined when unobserved), so a caller
   *  holding a pushed generation can tell a stale cache from a stale push; optional. */
  observedGeneration?(id: SessionId): number | undefined;
  /** Adopt an assignment announced out-of-band by the controller's revive push, which routinely
   *  arrives before the watch event for the same write; optional. */
  adoptAssignment?(id: SessionId, generation: number): void;
}

/** A guard that always allows, the single-replica default. */
export const allowAllGuard: OwnershipGuard = { canWrite: () => true };

/** One conversation's assignment as observed from its Conversation CR. */
export interface Assignment {
  hostPod: string;
  generation: number;
}

/**
 * The pure decision core, testable without k8s: a cache of conversationId -> Assignment
 * updated by the watch loop, plus this pod's identity and the generation it believes it
 * was assigned under.
 */
export class OwnershipTracker implements OwnershipGuard {
  /** conversationId -> the CR's current {hostPod, generation}. */
  private readonly assignments = new Map<string, Assignment>();
  /** conversationId -> the generation this pod started hosting under (its claim epoch). */
  private readonly claimedGen = new Map<string, number>();

  /** Fired when the watch shows this pod gaining a conversation it did not hold, the one signal
   *  that always fires on a reassignment; not fired on same-owner echoes. */
  onGained?: (id: string, generation: number) => void;

  constructor(private readonly selfPod: string) {}

  /** Called by the watch when a Conversation CR changes. */
  observe(id: string, a: Assignment | null): void {
    if (a === null) {
      this.assignments.delete(id);
      this.claimedGen.delete(id);
      return;
    }
    const prev = this.assignments.get(id);
    this.assignments.set(id, a);
    // The first time we see ourselves as the host, record the generation as our claim.
    if (a.hostPod === this.selfPod && !this.claimedGen.has(id)) {
      this.claimedGen.set(id, a.generation);
    }
    // Gain = we are the host now and were not before.
    if (a.hostPod === this.selfPod && prev?.hostPod !== this.selfPod) {
      this.onGained?.(id, a.generation);
    }
  }

  observedGeneration(id: SessionId): number | undefined {
    return this.assignments.get(id as string)?.generation;
  }

  adoptAssignment(id: SessionId, generation: number): void {
    // The caller has verified this push is newer than the cached view; a later watch event
    // overwrites this entry.
    this.observe(id as string, { hostPod: this.selfPod, generation });
  }

  canWrite(id: SessionId): boolean {
    const a = this.assignments.get(id as string);
    // Unknown: fail open so a new conversation can write before its CR is created and assigned.
    if (a === undefined) return true;
    // Owned by another pod now.
    if (a.hostPod !== this.selfPod) return false;
    // Owned by us at a generation newer than our claim means we were reassigned away and back, so
    // re-record and allow.
    const claimed = this.claimedGen.get(id);
    if (claimed === undefined || a.generation > claimed) {
      this.claimedGen.set(id, a.generation);
    }
    return true;
  }
}
