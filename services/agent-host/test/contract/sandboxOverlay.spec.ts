/**
 * The consumer Sandbox-manifest overlay, a recursive patch deep-merged onto the
 * generated Sandbox so a deployment can change the pod manifest without patching
 * Scooter. deepMerge recurses objects, replaces scalars and strategic-merges arrays by
 * `name`; reassertProtected keeps Scooter's identity, auth and storage wiring intact
 * under a hostile overlay; parseOverlay turns YAML or JSON into an object.
 */

import { describe, it, expect } from "vitest";

import { sandboxManifest } from "../../src/session/k8sProvisioner.js";
import {
  OverlayError,
  applyOverlay,
  deepMerge,
  parseOverlay,
  reassertProtected,
} from "../../src/session/sandboxOverlay.js";

type Obj = Record<string, any>;

const manifest = (overlay?: Obj): Obj =>
  sandboxManifest("c1", "conv-c1", "sandbox-c1", "img:latest", "agent-sandbox", "agent-broker", "10Gi", false, {
    extraEnv: [{ name: "CONVERSATION_ID", value: "c1" }],
    ...(overlay ? { overlay } : {}),
  }) as Obj;

const container = (m: Obj): Obj => {
  const c = m.spec.podTemplate.spec.containers.find((x: Obj) => x.name === "sandbox");
  if (!c) throw new Error("no sandbox container");
  return c;
};
const envOf = (m: Obj): Record<string, string> =>
  Object.fromEntries(container(m).env.map((e: Obj) => [e.name, e.value]));

// --- deepMerge: objects ------------------------------------------------------

describe("deepMerge — objects", () => {
  it("recurses nested objects and adds new keys", () => {
    expect(deepMerge({ a: { x: 1, y: 2 }, keep: true }, { a: { y: 20, z: 30 } })).toEqual({
      a: { x: 1, y: 20, z: 30 },
      keep: true,
    });
  });

  it("replaces a scalar", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("does NOT mutate its inputs", () => {
    const base = { a: { x: 1 } };
    const over = { a: { y: 2 } };
    deepMerge(base, over);
    expect(base).toEqual({ a: { x: 1 } });
    expect(over).toEqual({ a: { y: 2 } });
  });
});

// --- deepMerge: strategic array merge by `name` ------------------------------

describe("deepMerge — strategic array merge by name", () => {
  it("patches the matching item in place, leaving siblings alone", () => {
    const base = { env: [{ name: "A", value: "1" }, { name: "B", value: "2" }] };
    const over = { env: [{ name: "B", value: "20" }] };
    expect(deepMerge(base, over)).toEqual({
      env: [{ name: "A", value: "1" }, { name: "B", value: "20" }],
    });
  });

  it("appends an item whose name is absent from the base", () => {
    expect(deepMerge({ env: [{ name: "A", value: "1" }] }, { env: [{ name: "C", value: "3" }] })).toEqual({
      env: [{ name: "A", value: "1" }, { name: "C", value: "3" }],
    });
  });

  it("appends UNNAMED items (tolerations have no name to match on)", () => {
    expect(deepMerge({ tolerations: [{ key: "a" }] }, { tolerations: [{ key: "b" }] })).toEqual({
      tolerations: [{ key: "a" }, { key: "b" }],
    });
  });

  it("merges DEEPLY within a matched item", () => {
    const base = { c: [{ name: "sandbox", resources: { limits: { memory: "4Gi" } } }] };
    const over = { c: [{ name: "sandbox", resources: { limits: { cpu: "2" } } }] };
    expect((deepMerge(base, over) as Obj).c[0].resources.limits).toEqual({ memory: "4Gi", cpu: "2" });
  });

  it("rejects a type mismatch instead of silently replacing", () => {
    expect(() => deepMerge({ a: [1, 2] }, { a: { x: 1 } })).toThrow(OverlayError);
  });
});

// --- reassertProtected -------------------------------------------------------

describe("reassertProtected — a hostile overlay cannot break Scooter's wiring", () => {
  it("restores the ServiceAccount", () => {
    const base = manifest();
    const merged = deepMerge(base, { spec: { podTemplate: { spec: { serviceAccountName: "evil" } } } }) as Obj;
    expect(reassertProtected(base, merged).spec.podTemplate.spec.serviceAccountName).toBe("sandbox-c1");
  });

  it("restores the projected broker-token volume", () => {
    const base = manifest();
    const merged = deepMerge(base, {
      spec: { podTemplate: { spec: { volumes: [{ name: "broker-token", configMap: { name: "evil" } }] } } },
    }) as Obj;
    const fixed = reassertProtected(base, merged);
    const bt = fixed.spec.podTemplate.spec.volumes.find((v: Obj) => v.name === "broker-token");
    expect(bt.projected).toBeTruthy();
    expect(bt.configMap).toBeUndefined();
  });

  it("restores the PVC templates an overlay tried to drop", () => {
    const base = manifest();
    const merged = deepMerge(base, { spec: { volumeClaimTemplates: [] } }) as Obj;
    const fixed = reassertProtected(base, merged);
    expect(fixed.spec.volumeClaimTemplates.some((v: Obj) => v.metadata.name === "workspace")).toBe(true);
  });

  it("protects identity env PER VARIABLE while keeping added env", () => {
    const base = manifest();
    const merged = deepMerge(base, {
      spec: {
        podTemplate: {
          spec: {
            containers: [
              {
                name: "sandbox",
                env: [
                  { name: "CONVERSATION_ID", value: "spoofed" },
                  { name: "MY_TOOL", value: "ok" },
                ],
              },
            ],
          },
        },
      },
    }) as Obj;
    const env = envOf(reassertProtected(base, merged));
    expect(env.CONVERSATION_ID).toBe("c1");
    expect(env.MY_TOOL).toBe("ok");
  });
});

// --- applyOverlay + parseOverlay ---------------------------------------------

describe("applyOverlay / parseOverlay", () => {
  it("an empty overlay is the identity", () => {
    const base = manifest();
    expect(applyOverlay(base, {})).toEqual(base);
  });

  it("parses empty/whitespace to {}", () => {
    expect(parseOverlay("")).toEqual({});
    expect(parseOverlay("   \n  ")).toEqual({});
    expect(parseOverlay(undefined)).toEqual({});
  });

  it("accepts BOTH JSON (what kubenix writes) and YAML (what a human edits)", () => {
    expect(parseOverlay('{"spec": {"a": 1}}')).toEqual({ spec: { a: 1 } });
    expect(parseOverlay("spec:\n  a: 1\n")).toEqual({ spec: { a: 1 } });
  });

  it("rejects a non-mapping top level", () => {
    expect(() => parseOverlay("- 1\n- 2")).toThrow(OverlayError);
  });

  it("rejects a syntax error rather than silently applying nothing", () => {
    expect(() => parseOverlay("{ this: is: not: valid")).toThrow(OverlayError);
  });
});

// --- integration through sandboxManifest(overlay) ----------------------------

describe("sandboxManifest(overlay)", () => {
  it("adds nodeSelector + tolerations (the reason this exists)", () => {
    const m = manifest({
      spec: {
        podTemplate: {
          spec: {
            nodeSelector: { "scooter.io/pool": "sandbox" },
            tolerations: [{ key: "sandbox", operator: "Exists", effect: "NoSchedule" }],
          },
        },
      },
    });
    const ps = m.spec.podTemplate.spec;
    expect(ps.nodeSelector).toEqual({ "scooter.io/pool": "sandbox" });
    expect(ps.tolerations[0].key).toBe("sandbox");
    expect(ps.serviceAccountName).toBe("sandbox-c1");
  });

  it("patches ONE env var by name, leaving the base env in place", () => {
    const m = manifest({
      spec: {
        podTemplate: {
          spec: { containers: [{ name: "sandbox", env: [{ name: "MY_TOOL_URL", value: "http://tool.ns.svc:8080" }] }] },
        },
      },
    });
    const env = envOf(m);
    expect(env.MY_TOOL_URL).toBe("http://tool.ns.svc:8080");
    expect(env.BROKER_URL).toMatch(/^http:\/\/agent-broker/);
  });

  it("cannot break protected fields end to end", () => {
    const m = manifest({
      spec: {
        podTemplate: {
          spec: {
            serviceAccountName: "evil",
            volumes: [{ name: "broker-token", configMap: { name: "evil" } }],
          },
        },
      },
    });
    const ps = m.spec.podTemplate.spec;
    expect(ps.serviceAccountName).toBe("sandbox-c1");
    expect(ps.volumes.find((v: Obj) => v.name === "broker-token").projected).toBeTruthy();
  });
});

describe("volumeClaimTemplates — merged by metadata.name", () => {
  const claim = (m: Obj, name: string): Obj =>
    m.spec.volumeClaimTemplates.find((v: Obj) => v.metadata.name === name);
  const patch = (name: string, spec: Obj): Obj => ({ spec: { volumeClaimTemplates: [{ metadata: { name }, spec }] } });

  it("sets the workspace claim's class without touching its size", () => {
    const m = manifest(patch("workspace", { storageClassName: "gp3" }));
    expect(m.spec.volumeClaimTemplates).toHaveLength(1);
    expect(claim(m, "workspace").spec).toEqual({
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "10Gi" } },
      storageClassName: "gp3",
    });
  });

  it("overrides the workspaceStorageClass option", () => {
    const m = sandboxManifest("c1", "conv-c1", "sa", "img", "ns", "aud", "10Gi", false, {
      workspaceStorageClass: "from-option",
      overlay: patch("workspace", { storageClassName: "from-overlay" }),
    }) as Obj;
    expect(claim(m, "workspace").spec.storageClassName).toBe("from-overlay");
  });

  it("keeps the workspace claim's size and access modes", () => {
    const m = manifest(patch("workspace", { accessModes: ["ReadWriteMany"], resources: { requests: { storage: "1Ti" } } }));
    expect(claim(m, "workspace").spec.accessModes).toEqual(["ReadWriteOnce"]);
    expect(claim(m, "workspace").spec.resources).toEqual({ requests: { storage: "10Gi" } });
  });

  it("can't rebind the workspace claim to another volume", () => {
    const m = manifest(patch("workspace", { volumeName: "pv-other", dataSource: { name: "snap" } }));
    expect(claim(m, "workspace").spec.volumeName).toBeUndefined();
    expect(claim(m, "workspace").spec.dataSource).toBeUndefined();
  });

  it("keeps the whole overlay-store claim spec", () => {
    const m = sandboxManifest("c1", "conv-c1", "sa", "img", "ns", "aud", "10Gi", true, {
      overlayStore: true,
      overlayStorageClass: "warm-store-retain",
      overlay: patch("scooter-rw", { storageClassName: "other" }),
    }) as Obj;
    expect(claim(m, "scooter-rw").spec.storageClassName).toBe("warm-store-retain");
  });
});

describe("mergeLists — repeated names in one overlay", () => {
  it("folds a name the base lacks into one item, the later entry winning", () => {
    const merged = deepMerge(
      { env: [{ name: "A", value: "base" }] },
      { env: [{ name: "B", value: "1" }, { name: "B", value: "2" }] },
    ) as Obj;
    expect(merged.env).toEqual([{ name: "A", value: "base" }, { name: "B", value: "2" }]);
  });
});
