/**
 * Consumer-supplied Sandbox manifest overlay: a recursive patch applied on top of the
 * generated per-conversation Sandbox, so a deployment (or a contrib, via a second key of
 * the same ConfigMap) can change the pod manifest without patching Scooter's code. The
 * ConfigMap is read on every create, parsed, and applied to the dict `sandboxManifest()`
 * returns. Objects deep-merge, scalars replace, arrays strategic-merge by `name`, and the
 * overlay wins everywhere except the PROTECTED_PATHS, which are re-asserted from the base
 * after the merge. (Nix expands any `<list>Attrs` sugar before the overlay is rendered.)
 */

import { loadYaml } from "@kubernetes/client-node";

type Json = unknown;
type JsonObject = Record<string, unknown>;

/** The merge key for strategic array merges, as k8s uses for containers/env/volumes/volumeMounts. */
const LIST_MERGE_KEY = "name";

/** An item's identity: `name`, or `metadata.name` for volumeClaimTemplates. */
function itemKey(item: unknown): unknown {
  if (!isObject(item)) return undefined;
  if (LIST_MERGE_KEY in item) return item[LIST_MERGE_KEY];
  return isObject(item.metadata) ? item.metadata.name : undefined;
}

/**
 * Dotted paths that Scooter owns, forced back to the generated value after the merge; a
 * `key[name=X]` segment selects one array item, so env is protected per-variable and a
 * deployment can still add env.
 */
export const PROTECTED_PATHS: readonly string[] = [
  "apiVersion",
  "kind",
  "metadata.name",
  "spec.podTemplate.spec.serviceAccountName",
  "spec.podTemplate.spec.automountServiceAccountToken",
  "spec.podTemplate.spec.volumes[name=broker-token]",
  "spec.podTemplate.spec.containers[name=sandbox].volumeMounts[name=broker-token]",
  "spec.podTemplate.spec.containers[name=sandbox].volumeMounts[name=workspace]",
  // A claim's spec could rebind it (volumeName, dataSource); PATCHABLE_PATHS reopens the class.
  "spec.volumeClaimTemplates[name=workspace].spec",
  "spec.volumeClaimTemplates[name=scooter-rw].spec",
  // Identity / broker env, protected per-variable.
  "spec.podTemplate.spec.containers[name=sandbox].env[name=CONVERSATION_ID]",
  "spec.podTemplate.spec.containers[name=sandbox].env[name=BROKER_URL]",
  "spec.podTemplate.spec.containers[name=sandbox].env[name=BROKER_TOKEN_PATH]",
];

/** Paths inside a protected subtree that the overlay may still set; the overlay-store claim
 *  is absent because its class must match the warm pool's PVs. */
export const PATCHABLE_PATHS: readonly string[] = [
  "spec.volumeClaimTemplates[name=workspace].spec.storageClassName",
  "spec.volumeClaimTemplates[name=workspace].spec.volumeAttributesClassName",
];

/** The overlay payload is malformed, thrown so the caller fails loudly rather than silently
 *  dropping the overlay. */
export class OverlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverlayError";
  }
}

const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep-copy a plain JSON-ish value so a merge result never aliases an input. */
function copy<T>(v: T): T {
  if (Array.isArray(v)) return v.map(copy) as unknown as T;
  if (isObject(v)) {
    const out: JsonObject = {};
    for (const [k, x] of Object.entries(v)) out[k] = copy(x);
    return out as unknown as T;
  }
  return v;
}

/**
 * Parse the ConfigMap's overlay payload (YAML, a superset of JSON) into an object; empty is
 * `{}`, and a non-mapping top level or a syntax error is an OverlayError.
 */
export function parseOverlay(raw: string | undefined | null): JsonObject {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = loadYaml<unknown>(raw);
  } catch (e) {
    throw new OverlayError(`manifest overlay is not valid YAML/JSON: ${(e as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isObject(parsed)) {
    throw new OverlayError(
      `manifest overlay must be a mapping at the top level, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
  }
  return parsed;
}

/**
 * Recursively merge `overlay` onto `base` without mutating either: objects merge key-wise,
 * arrays strategic-merge by LIST_MERGE_KEY, anything else is replaced, and a
 * container-vs-scalar mismatch is an OverlayError.
 */
export function deepMerge(base: Json, overlay: Json): Json {
  if (isObject(base) && isObject(overlay)) {
    const out: JsonObject = { ...base };
    for (const [k, ov] of Object.entries(overlay)) {
      out[k] = k in base ? deepMerge(base[k], ov) : copy(ov);
    }
    return out;
  }

  if (Array.isArray(base) && Array.isArray(overlay)) return mergeLists(base, overlay);

  // A scalar replacing a scalar is fine; a shape change between containers is not.
  const baseIsContainer = isObject(base) || Array.isArray(base);
  const sameShape = Array.isArray(base) === Array.isArray(overlay) && isObject(base) === isObject(overlay);
  if (baseIsContainer && !sameShape) {
    throw new OverlayError(
      `overlay type ${Array.isArray(overlay) ? "array" : typeof overlay} cannot merge onto ` +
        `base type ${Array.isArray(base) ? "array" : typeof base}`,
    );
  }

  return copy(overlay);
}

/**
 * Strategic-merge two arrays by LIST_MERGE_KEY: base items keep their order, a matching
 * overlay item is deep-merged in place, and an unnamed or unmatched one is appended.
 */
function mergeLists(base: unknown[], overlay: unknown[]): unknown[] {
  const out = base.map(copy);
  const index = new Map<unknown, number>();
  out.forEach((item, i) => {
    const key = itemKey(item);
    if (key !== undefined) index.set(key, i);
  });
  for (const ov of overlay) {
    const key = itemKey(ov);
    const at = key !== undefined ? index.get(key) : undefined;
    if (at !== undefined) out[at] = deepMerge(out[at], ov);
    else if (key !== undefined) index.set(key, out.push(copy(ov)) - 1);
    else out.push(copy(ov));
  }
  return out;
}

// --- protected-path resolution ----------------------------------------------
// A path is dotted; a segment is `key` or `key[name=X]` (the item of the array at `key` whose
// LIST_MERGE_KEY === X).

interface Seg {
  key: string;
  sel?: string;
}

function parsePath(path: string): Seg[] {
  return path.split(".").map((raw) => {
    if (raw.endsWith("]") && raw.includes("[name=")) {
      const [key, rest] = raw.split("[name=", 2);
      return { key, sel: rest.slice(0, -1) };
    }
    return { key: raw };
  });
}

/** Resolve `segs` in `root`; `found` is false if any segment is missing. */
function getPath(root: Json, segs: Seg[]): { value: Json; found: boolean } {
  let cur: Json = root;
  for (const seg of segs) {
    if (!isObject(cur) || !(seg.key in cur)) return { value: undefined, found: false };
    cur = cur[seg.key];
    if (seg.sel !== undefined) {
      if (!Array.isArray(cur)) return { value: undefined, found: false };
      const match = cur.find((it) => itemKey(it) === seg.sel);
      if (match === undefined) return { value: undefined, found: false };
      cur = match;
    }
  }
  return { value: cur, found: true };
}

/** The array item selected by `seg`, created and appended when absent, so a mid-path `key[name=X]`
 *  can be traversed for setting. */
function resolveSelector(list: Json, seg: Seg): JsonObject {
  if (Array.isArray(list)) {
    const found = list.find((it) => itemKey(it) === seg.sel);
    if (isObject(found)) return found;
  }
  const item: JsonObject = { [LIST_MERGE_KEY]: seg.sel };
  if (Array.isArray(list)) list.push(item);
  return item;
}

/** Set `segs` in `root` to a fresh copy of `value`, creating intermediate objects as needed and
 *  appending a missing array-item leaf. */
function setPath(root: JsonObject, segs: Seg[], value: Json): void {
  let cur: JsonObject = root;
  for (const seg of segs.slice(0, -1)) {
    let next = cur[seg.key];
    if (!isObject(next) && !Array.isArray(next)) {
      next = {};
      cur[seg.key] = next;
    }
    cur = seg.sel !== undefined ? resolveSelector(next, seg) : (next as JsonObject);
  }

  const leaf = segs[segs.length - 1];
  if (leaf.sel === undefined) {
    cur[leaf.key] = copy(value);
    return;
  }
  const list = cur[leaf.key];
  if (!Array.isArray(list)) {
    cur[leaf.key] = [copy(value)];
    return;
  }
  const at = list.findIndex((it) => itemKey(it) === leaf.sel);
  if (at >= 0) list[at] = copy(value);
  else list.push(copy(value));
}

/** Force every PROTECTED_PATHS value back to what `base` had, skipping paths absent from `base`,
 *  then restore the overlay's PATCHABLE_PATHS values. */
export function reassertProtected(base: JsonObject, merged: JsonObject): JsonObject {
  const out = copy(merged);
  for (const path of PROTECTED_PATHS) {
    const segs = parsePath(path);
    const { value, found } = getPath(base, segs);
    if (!found) continue;
    setPath(out, segs, value);
  }
  for (const path of PATCHABLE_PATHS) {
    const segs = parsePath(path);
    const { value, found } = getPath(merged, segs);
    if (found) setPath(out, segs, value);
  }
  return out;
}

/** The public entry point, `reassertProtected(base, deepMerge(base, overlay))`; an empty overlay
 *  returns `base` unchanged. */
export function applyOverlay(base: JsonObject, overlay: JsonObject): JsonObject {
  if (!overlay || Object.keys(overlay).length === 0) return base;
  return reassertProtected(base, deepMerge(base, overlay) as JsonObject);
}
