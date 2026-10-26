// Covers .github/scripts/k3d-cache-trim.sh, run as k3d-platform-up.sh runs it,
// with `df` and `docker` stubbed on PATH so free space and live mounts are inputs.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const realFind = execFileSync("bash", ["-c", "command -v find"], { encoding: "utf8" }).trim();
const script = fileURLToPath(new URL("../.github/scripts/k3d-cache-trim.sh", import.meta.url));

/** freeGb: dir -> GB free on its volume; mounted: dirs a container bind-mounts. */
function setup({ freeGb, mounted = [], sudo = false }) {
  const root = mkdtempSync(join(tmpdir(), "k3d-trim-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const dirs = Object.keys(freeGb).map((name) => {
    const dir = join(root, name);
    mkdirSync(join(dir, "blobs"), { recursive: true });
    writeFileSync(join(dir, "blobs", "layer"), "x");
    return dir;
  });
  const cases = dirs
    .map((dir, i) => `  ${dir}) kb=${Object.values(freeGb)[i] * 1048576} ;;`)
    .join("\n");
  writeFileSync(
    join(bin, "df"),
    `#!/usr/bin/env bash\ncase "\${@: -1}" in\n${cases}\n  *) exit 1 ;;\nesac\n` +
      `echo "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "/dev/x 100 0 $kb 1% /"\n`,
  );
  const mounts = mounted.map((name) => join(root, name)).join("\\n");
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash\ncase "$1" in\n  ps) ${mounted.length ? "echo c1" : ":"} ;;\n  inspect) printf '${mounts}\\n' ;;\n` +
      `  run) echo "$*" >> "${root}/docker-run.log"; while [ "$1" != -v ]; do shift; done; rm -rf "\${2%%:*}"/* ;;\nesac\n`,
  );
  // `find` logs who ran it; `sudo` either runs the command (passwordless) or refuses.
  writeFileSync(join(bin, "find"), `#!/usr/bin/env bash\necho "\${FIND_AS:-user}" >> "${root}/find.log"\nexec ${realFind} "$@"\n`);
  writeFileSync(
    join(bin, "sudo"),
    sudo ? '#!/usr/bin/env bash\n[ "$1" = -n ] && shift\nFIND_AS=root exec "$@"\n' : "#!/usr/bin/env bash\nexit 1\n",
  );
  chmodSync(join(bin, "find"), 0o755);
  chmodSync(join(bin, "sudo"), 0o755);
  chmodSync(join(bin, "df"), 0o755);
  chmodSync(join(bin, "docker"), 0o755);
  const run = (env = {}) =>
    execFileSync("bash", [script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, K3D_CACHE_DIRS: dirs.join(" "), ...env },
      encoding: "utf8",
    });
  const emptied = (name) => readdirSync(join(root, name)).length === 0;
  return { root, run, emptied };
}

describe("k3d-cache-trim", () => {
  it("keeps both caches when the volume has room", () => {
    const t = setup({ freeGb: { containerd: 40, registry: 40 } });
    t.run();
    expect(t.emptied("containerd")).toBe(false);
    expect(t.emptied("registry")).toBe(false);
  });

  it("empties a short cache but keeps the directory the runner bind-mounts", () => {
    const t = setup({ freeGb: { containerd: 12, registry: 40 } });
    const log = t.run();
    expect(t.emptied("containerd")).toBe(true);
    expect(existsSync(join(t.root, "containerd"))).toBe(true);
    expect(t.emptied("registry")).toBe(false);
    expect(log).toContain("emptied");
  });

  // An unprivileged pass would delete only the files it owns, leaving a registry
  // whose manifests name blobs that are gone.
  it("without sudo, empties through a root container and never deletes as the runner user", () => {
    const t = setup({ freeGb: { containerd: 5 } });
    const log = t.run();
    expect(t.emptied("containerd")).toBe(true);
    expect(log).toContain("emptied");
    expect(readFileSync(join(t.root, "docker-run.log"), "utf8")).toContain("--entrypoint find");
    expect(existsSync(join(t.root, "find.log"))).toBe(false);
  });

  it("with passwordless sudo, deletes as root without a container", () => {
    const t = setup({ freeGb: { containerd: 5 }, sudo: true });
    t.run();
    expect(t.emptied("containerd")).toBe(true);
    expect(existsSync(join(t.root, "docker-run.log"))).toBe(false);
    expect(readFileSync(join(t.root, "find.log"), "utf8").trim()).toBe("root");
  });

  it("never empties a cache a live container mounts", () => {
    const t = setup({ freeGb: { containerd: 5, registry: 5 }, mounted: ["registry"] });
    const log = t.run();
    expect(t.emptied("containerd")).toBe(true);
    expect(t.emptied("registry")).toBe(false);
    expect(log).toContain("mounted by a live container");
  });

  it("honours K3D_MIN_FREE_GB", () => {
    const t = setup({ freeGb: { containerd: 12, registry: 12 } });
    t.run({ K3D_MIN_FREE_GB: "10" });
    expect(t.emptied("containerd")).toBe(false);
  });

  it("skips missing caches and bad floors without failing the job", () => {
    const t = setup({ freeGb: { containerd: 1 } });
    expect(() => t.run({ K3D_CACHE_DIRS: join(t.root, "absent") })).not.toThrow();
    expect(t.run({ K3D_MIN_FREE_GB: "lots" })).toContain("not a whole number");
    expect(t.emptied("containerd")).toBe(false);
  });
});
