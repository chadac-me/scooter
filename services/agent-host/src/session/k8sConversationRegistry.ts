/**
 * The CR-writing ConversationRegistry for multi-replica mode. register() creates a
 * `Conversation` CR named by the conversation id without status, which the controller
 * owns; it is idempotent and swallows k8s errors so a conversation still starts locally.
 * Every call retries a 429 (honouring `Retry-After`, else exponential backoff with
 * jitter), and setPhase coalesces a burst into the write in flight plus one final write;
 * nothing else is retried.
 */

import { KubeConfig, CustomObjectsApi, setHeaderOptions, PatchStrategy } from "@kubernetes/client-node";

import { logger } from "../log.js";

const log = logger("conversationRegistry");

import type {
  ConversationRegistry,
  ConversationSpec,
  ConversationPhase,
  ConversationRecord,
} from "./conversationRegistry.js";

const GROUP = "scooter.chadac.dev";
const VERSION = "v1alpha1";
const PLURAL = "conversations";

/** How the apiserver's priority-and-fairness layer says "slow down". */
const TOO_MANY_REQUESTS = 429;
/** Total tries per call, the first plus 4 retries. */
const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 8000;

/** Test seam: how the registry waits and how hard it retries. */
export interface RegistryRetryOptions {
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // A pending backoff must never be the reason the process stays alive.
    (t as unknown as { unref?: () => void }).unref?.();
  });

/**
 * The server's own `Retry-After` in ms, when it sent one, accepting both delta-seconds and
 * an HTTP-date.
 */
export function retryAfterMs(e: unknown, now: number = Date.now()): number | undefined {
  const headers = (e as { headers?: Record<string, string | string[] | undefined> })?.headers;
  if (!headers) return undefined;
  const raw =
    headers["retry-after"] ?? headers["Retry-After"] ?? headers["RETRY-AFTER"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Exponential backoff with full jitter, so the fleet does not retry in lockstep. */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.round(ceiling * (0.5 + Math.random() / 2));
}

/**
 * Build a registry that creates Conversation CRs in `namespace`; `kc` defaults to the
 * in-cluster config, and the CR name is the conversation id.
 */
export function createK8sConversationRegistry(
  namespace: string,
  kc?: KubeConfig,
  retry: RegistryRetryOptions = {},
): ConversationRegistry {
  const config = kc ?? loadKubeConfig();
  const custom = config.makeApiClient(CustomObjectsApi);
  const maxAttempts = retry.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = retry.sleep ?? realSleep;

  /**
   * Run a k8s call, retrying only on 429; every other error is returned unchanged.
   */
  async function throttled<T>(op: string, id: string, call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (e) {
        const code = (e as { code?: number })?.code;
        if (code !== TOO_MANY_REQUESTS || attempt >= maxAttempts - 1) throw e;
        const serverAsked = retryAfterMs(e);
        const wait = serverAsked ?? backoffMs(attempt);
        log.warn("apiserver throttled a Conversation write; backing off", {
          conversation_id: id,
          operation: op,
          attempt: attempt + 1,
          wait_ms: wait,
          honored_retry_after: serverAsked !== undefined,
        });
        await sleep(wait);
      }
    }
  }

  /** The phase last successfully published per conversation, so a phase the CR already carries is
   *  not re-written. */
  const published = new Map<string, ConversationPhase>();
  /** The in-flight status write per conversation, with at most one phase queued behind it. */
  const phaseWrites = new Map<string, { inflight: Promise<void>; queued?: ConversationPhase }>();

  async function patchPhase(id: string, phase: ConversationPhase): Promise<void> {
    await throttled("setPhase", id, () =>
      custom.patchNamespacedCustomObjectStatus(
        { group: GROUP, version: VERSION, namespace, plural: PLURAL, name: id, body: { status: { phase } } },
        setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
      ),
    )
      .then(() => {
        published.set(id, phase);
      })
      .catch((e: { code?: number }) => {
        // `published` is not recorded on failure, so the next setPhase retries.
        if (e?.code === 404) return; // no CR to update
        log.errorWith("failed to set phase", e, { conversation_id: id, phase });
      });
  }

  return {
    async register(id: string, spec: ConversationSpec): Promise<void> {
      // Drop undefined fields, since an explicit `undefined` serializes to nothing useful.
      const cleanSpec: Record<string, string> = {};
      if (spec.model) cleanSpec.model = spec.model;
      if (spec.owner) cleanSpec.owner = spec.owner;
      if (spec.parentId) cleanSpec.parentId = spec.parentId;
      if (spec.sandboxRef) cleanSpec.sandboxRef = spec.sandboxRef;
      if (spec.creatorPod) cleanSpec.creatorPod = spec.creatorPod;

      // PATCH first, creating only on a 404.
      await throttled("register.patchSpec", id, () =>
        custom.patchNamespacedCustomObject(
          { group: GROUP, version: VERSION, namespace, plural: PLURAL, name: id, body: { spec: cleanSpec } },
          setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
        ),
      )
        .catch(async (e: { code?: number }) => {
          // Only a 404 means there is no CR.
          if (e?.code !== 404) {
            log.errorWith("failed to patch Conversation CR", e, { conversation_id: id });
            return;
          }
          await throttled("register", id, () =>
            custom.createNamespacedCustomObject({
              group: GROUP,
              version: VERSION,
              namespace,
              plural: PLURAL,
              body: {
                apiVersion: `${GROUP}/${VERSION}`,
                kind: "Conversation",
                metadata: { name: id, namespace },
                spec: cleanSpec,
              },
            }),
          ).catch((ce: { code?: number }) => {
            // A creator landed inside the 404 window.
            if (ce?.code === 409) return;
            log.errorWith("failed to create Conversation CR", ce, { conversation_id: id });
          });
        });
    },

    async setPhase(id: string, phase: ConversationPhase): Promise<void> {
      // A merge patch of just {phase} on the status subresource leaves hostPod/hostIP/generation
      // untouched, and a failure only lags the kubectl view.

      // Coalesced: a phase already published is not written, and while a write is in flight only
      // the last phase asked for is written after it.
      if (published.get(id) === phase) return;
      const inflight = phaseWrites.get(id);
      if (inflight) {
        inflight.queued = phase;
        return inflight.inflight;
      }
      const entry: { inflight: Promise<void>; queued?: ConversationPhase } = {
        inflight: Promise.resolve(),
        queued: phase,
      };
      phaseWrites.set(id, entry);
      entry.inflight = (async () => {
        for (;;) {
          const next = entry.queued;
          // Unregister synchronously at the moment we stop, so no caller queues onto an entry
          // nobody will drain.
          if (next === undefined) {
            phaseWrites.delete(id);
            return;
          }
          entry.queued = undefined;
          if (published.get(id) === next) continue;
          await patchPhase(id, next);
        }
      })();
      return entry.inflight;
    },

    async remove(id: string): Promise<void> {
      // Never throws: a k8s failure must not turn a successful local delete into a 500, and a 404
      // is the desired end state.

      // Forget the coalescer's memory so a CR recreated under the same id is published to afresh.
      published.delete(id);
      phaseWrites.delete(id);
      await throttled("remove", id, () =>
        custom.deleteNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace,
          plural: PLURAL,
          name: id,
        }),
      )
        .catch((e: { code?: number }) => {
          if (e?.code === 404) return; // already gone
          log.errorWith("failed to delete the Conversation CR (it will be re-adopted)", e, {
            conversation_id: id,
          });
        });
    },

    async list(): Promise<ConversationRecord[]> {
      // Throws on failure, unlike the write methods: a caller that got [] from a blip would
      // conclude it owns nothing and serve blind.
      const resp = await throttled("list", "*", () =>
        custom.listNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace,
          plural: PLURAL,
        }),
      );
      const items = (resp as { items?: unknown[] })?.items ?? [];
      return items.map((o) => toRecord(o)).filter((r): r is ConversationRecord => r !== undefined);
    },

    async get(id: string): Promise<ConversationRecord | undefined> {
      try {
        const obj = await throttled("get", id, () =>
          custom.getNamespacedCustomObject({
            group: GROUP,
            version: VERSION,
            namespace,
            plural: PLURAL,
            name: id,
          }),
        );
        return toRecord(obj);
      } catch (e) {
        // Absent is `undefined`, not an error.
        if ((e as { code?: number })?.code === 404) return undefined;
        throw e;
      }
    },
  };
}

/** Map a raw CR to the host's view, or undefined for an object with no usable name. */
function toRecord(o: unknown): ConversationRecord | undefined {
  const cr = o as {
    metadata?: { name?: string };
    spec?: ConversationSpec;
    status?: { phase?: ConversationPhase; hostPod?: string; hostIP?: string; generation?: number };
  };
  const id = cr?.metadata?.name;
  if (!id) return undefined;
  return {
    id,
    spec: cr.spec ?? {},
    // status is absent entirely on a CR the controller has not reconciled yet.
    phase: cr.status?.phase,
    hostPod: cr.status?.hostPod,
    hostIP: cr.status?.hostIP,
    generation: cr.status?.generation,
  };
}

function loadKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromCluster();
  return kc;
}
