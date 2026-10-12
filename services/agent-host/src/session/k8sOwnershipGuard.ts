/**
 * Wires an OwnershipTracker to a live watch of the Conversation CRD, so the fencing
 * decision (canWrite) reflects the current status.hostPod / generation with no per-append
 * k8s call. Used only in multi-replica mode (POD_NAME set).
 */

import { KubeConfig, Watch } from "@kubernetes/client-node";

import { OwnershipTracker } from "./ownershipGuard.js";

const GROUP = "scooter.chadac.dev";
const VERSION = "v1alpha1";
const PLURAL = "conversations";

interface ConversationCR {
  metadata?: { name?: string };
  status?: { hostPod?: string; generation?: number };
}

/**
 * Build the tracker for `selfPod` and start a self-reconnecting watch of Conversations in
 * `namespace`, returning the tracker and a stop(); `kc` defaults to the in-cluster config.
 */
export function createK8sOwnershipGuard(
  selfPod: string,
  namespace: string,
  kc?: KubeConfig,
): { guard: OwnershipTracker; stop: () => void } {
  const config = kc ?? loadKubeConfig();
  const tracker = new OwnershipTracker(selfPod);
  const watch = new Watch(config);
  let aborted = false;
  let req: { abort: () => void } | undefined;

  const onEvent = (type: string, obj: ConversationCR) => {
    const name = obj.metadata?.name;
    if (!name) return;
    if (type === "DELETED") {
      tracker.observe(name, null);
      return;
    }
    const hostPod = obj.status?.hostPod;
    const generation = obj.status?.generation;
    // An unassigned CR (no hostPod) stays unobserved, which fails open, until the controller
    // assigns one.
    if (hostPod && typeof generation === "number") {
      tracker.observe(name, { hostPod, generation });
    } else {
      tracker.observe(name, null);
    }
  };

  const start = () => {
    if (aborted) return;
    watch
      .watch(
        `/apis/${GROUP}/${VERSION}/namespaces/${namespace}/${PLURAL}`,
        {},
        onEvent as (type: string, obj: unknown) => void,
        // Reconnect on any close or error, since watches expire.
        () => { if (!aborted) setTimeout(start, 1000); },
      )
      .then((r) => { req = r as { abort: () => void }; })
      .catch(() => { if (!aborted) setTimeout(start, 2000); });
  };
  start();

  return {
    guard: tracker,
    stop: () => { aborted = true; req?.abort?.(); },
  };
}

function loadKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromCluster();
  return kc;
}
