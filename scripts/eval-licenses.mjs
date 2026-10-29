#!/usr/bin/env node
// Usage: eval-licenses.mjs [--out DIR]; writes licenses.json and index.html.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(root, "result-licenses");
const sh = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"], ...opts });

// --- Classification ---------------------------------------------------------

// Ordered from least to most obligation.
const CATEGORIES = ["first-party", "permissive", "attribution", "weak-copyleft", "strong-copyleft", "proprietary", "unknown"];

const RULES = [
  [/^(MIT|MIT-0|MIT-open-group|X11|ISC|0BSD|BSD-[0-9].*|Apache-2\.0|Zlib|zlib-acknowledgement|Unlicense|CC0-1\.0|WTFPL|Python-2\.0.*|PSF-2\.0|PostgreSQL|curl|blessing|publicDomain|Unicode-.*|ICU|bzip2-.*|TCL|HPND.*|SGI-B-2\.0|BlueOak-.*|BSL-1\.0|OFL-1\.1|TekHVC|hpndDifferentDisclaimer|Artistic-.*|AFL-.*|NCSA|W3C.*|libpng.*|IJG|FTL|OpenSSL|SSLeay|Ruby|Vim|Beerware|JSON)$/i, "permissive"],
  [/^CC-BY-(?!.*SA)/i, "attribution"],
  [/^(MPL-.*|LGPL-.*|EPL-.*|CDDL-.*|CC-BY-SA-.*|EUPL-.*|ODbL-.*|GPL-.*-with-.*exception|LGPL.*|lgpl.*)$/i, "weak-copyleft"],
  [/^(GPL-.*|AGPL-.*|SSPL-.*|OSL-.*|Sleepycat)$/i, "strong-copyleft"],
  [/^(unfree.*|UNLICENSED|SEE LICENSE IN .*|BUSL-.*|Elastic-.*|proprietary)$/i, "proprietary"],
];

const rank = (c) => CATEGORIES.indexOf(c);

export function classifyId(id) {
  for (const [re, cat] of RULES) if (re.test(id)) return cat;
  return "unknown";
}

// OR lets the licensee pick, so it takes the lowest.
export function classify(expr) {
  if (!expr) return "unknown";
  const s = String(expr).replace(/[()]/g, " ").trim();
  if (/\s+OR\s+/i.test(s)) return s.split(/\s+OR\s+/i).map(classify).sort((a, b) => rank(a) - rank(b))[0];
  if (/\s+AND\s+/i.test(s)) return s.split(/\s+AND\s+/i).map(classify).sort((a, b) => rank(b) - rank(a))[0];
  return classifyId(s.replace(/\+$/, "-or-later"));
}

// Metadata omits the license their shipped LICENSE file states.
const NPM_OVERRIDES = [[/^@ag-ui\//, "MIT"]];

// --- npm --------------------------------------------------------------------

function npmPackages() {
  const locks = sh("git", ["ls-files", "*package-lock.json", "package-lock.json"]).split("\n").filter(Boolean);
  const out = new Map();
  for (const lock of locks) {
    const data = JSON.parse(readFileSync(join(root, lock), "utf8"));
    for (const [path, meta] of Object.entries(data.packages ?? {})) {
      if (!path.includes("node_modules/") || meta.link) continue;
      const name = meta.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      const key = `${name}@${meta.version}`;
      const prev = out.get(key);
      const scope = meta.dev ? "dev" : "runtime";
      if (prev) {
        prev.sources.add(lock);
        if (scope === "runtime") prev.scope = "runtime";
        continue;
      }
      const lic = (typeof meta.license === "object" ? meta.license?.type : meta.license)
        ?? NPM_OVERRIDES.find(([re]) => re.test(name))?.[1];
      out.set(key, { ecosystem: "npm", name, version: meta.version, license: lic ?? null, scope, sources: new Set([lock]), homepage: `https://www.npmjs.com/package/${name}` });
    }
  }
  return [...out.values()];
}

// --- Go ---------------------------------------------------------------------

const LICENSE_TEXT = [
  [/Apache License[\s\S]{0,40}Version 2\.0/i, "Apache-2.0"],
  [/Mozilla Public License,? (v\. |version )?2\.0/i, "MPL-2.0"],
  [/GNU LESSER GENERAL PUBLIC LICENSE/i, "LGPL"],
  [/GNU AFFERO GENERAL PUBLIC LICENSE/i, "AGPL-3.0"],
  [/GNU GENERAL PUBLIC LICENSE/i, "GPL"],
  [/Permission is hereby granted, free of charge/i, "MIT"],
  [/Permission to use, copy, modify, and(\/or)? distribute this software for any/i, "ISC"],
  [/Neither the name|names of its contributors may be used/i, "BSD-3-Clause"],
  [/Redistributions in binary form must reproduce/i, "BSD-2-Clause"],
  [/This is free and unencumbered software released into the public domain/i, "Unlicense"],
];

export function detectLicenseText(text) {
  for (const [re, id] of LICENSE_TEXT) if (re.test(text)) return id;
  return null;
}

function goPackages() {
  const mods = sh("git", ["ls-files", "*go.mod"]).split("\n").filter(Boolean);
  const out = [];
  for (const mod of mods) {
    const dir = dirname(mod);
    const attr = { "services/conversation-router": "conversation-router", "pkgs/forge-shim": "forge-shim" }[dir];
    if (!attr) { console.error(`eval-licenses: no flake attr for ${mod}, skipping`); continue; }
    let vendor;
    try {
      vendor = sh("nix", ["build", "--no-link", "--print-out-paths", `.#${attr}.goModules`], { stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch { continue; } // No dependencies means no goModules output.
    if (!existsSync(join(vendor, "modules.txt"))) continue;
    for (const line of readFileSync(join(vendor, "modules.txt"), "utf8").split("\n")) {
      const m = line.match(/^# (\S+) (\S+)/);
      if (!m) continue;
      const [, name, version] = m;
      const modDir = join(vendor, name);
      if (!existsSync(modDir)) continue; // Nothing vendored, so nothing shipped.
      const file = readdirSync(modDir).find((f) => /^(LICEN[CS]E|COPYING)/i.test(f));
      const license = file ? detectLicenseText(readFileSync(join(modDir, file), "utf8")) : null;
      out.push({ ecosystem: "go", name, version, license, scope: "runtime", sources: new Set([mod]), homepage: `https://pkg.go.dev/${name}` });
    }
  }
  return out;
}

// --- Nix (and Python, which nixpkgs pins) ----------------------------------

function nixPackages() {
  const data = JSON.parse(sh("nix", ["eval", "--impure", "--json", "--expr", `import ${root}/nix/licenses.nix {}`]));
  const out = new Map();
  for (const [component, pkgs] of Object.entries(data)) {
    for (const p of pkgs) {
      const key = `${p.name}@${p.version}`;
      const prev = out.get(key);
      if (prev) { prev.sources.add(component); continue; }
      out.set(key, {
        ecosystem: p.python ? "python" : "nix",
        name: p.name, version: p.version, license: p.firstParty ? "MIT" : p.license,
        firstParty: p.firstParty, scope: "runtime", sources: new Set([component]), homepage: p.homepage,
      });
    }
  }
  return [...out.values()];
}

// --- Report -----------------------------------------------------------------

function attentionNote(p) {
  switch (p.category) {
    case "strong-copyleft": return p.ecosystem === "nix"
      ? "Redistributed as an unmodified binary in an image: ship the license text and point to the corresponding source."
      : "Copyleft dependency: confirm how it is linked and distributed.";
    case "weak-copyleft": return "File/library-level copyleft: keep the license text and any modifications' source available.";
    case "attribution": return "Requires attribution where the data/content is redistributed.";
    case "proprietary": return "Not open source; governed by the vendor's terms.";
    case "unknown": return "No license metadata found; check upstream manually.";
    default: return "";
  }
}

function main() {
  const packages = [...npmPackages(), ...goPackages(), ...nixPackages()].map((p) => {
    const category = p.firstParty ? "first-party" : classify(p.license);
    return { ...p, sources: [...p.sources].sort(), category, note: attentionNote({ ...p, category }) };
  }).sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));

  const count = (f) => packages.reduce((acc, p) => ((acc[f(p)] = (acc[f(p)] ?? 0) + 1), acc), {});
  const report = {
    generatedAt: new Date().toISOString(),
    commit: sh("git", ["rev-parse", "HEAD"]).trim(),
    totals: { packages: packages.length, byEcosystem: count((p) => p.ecosystem), byCategory: count((p) => p.category), byLicense: count((p) => p.license ?? "(none)") },
    packages,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "licenses.json"), JSON.stringify(report, null, 2));
  const html = readFileSync(join(root, "scripts/eval-licenses.html"), "utf8")
    .replace("/*REPORT*/null", () => JSON.stringify(report).replace(/</g, "\\u003c"));
  writeFileSync(join(outDir, "index.html"), html);
  process.stdout.write(summary(report));
  console.log(`\nwrote ${outDir}/{licenses.json,index.html}`);
}

function summary(r) {
  const lines = [`${r.totals.packages} packages (${Object.entries(r.totals.byEcosystem).map(([k, v]) => `${k} ${v}`).join(", ")})`];
  for (const c of CATEGORIES) if (r.totals.byCategory[c]) lines.push(`  ${c.padEnd(16)} ${r.totals.byCategory[c]}`);
  return lines.join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
