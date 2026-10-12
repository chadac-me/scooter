/**
 * Snippet builders for marimo's `marimo._code_mode` cell API. They return Python source
 * run through the scratchpad execute endpoint, since structural cell ops have no HTTP
 * endpoint and are driven from inside the kernel via `cm.get_context()`. The code-mode
 * surface is unstable, so every snippet lives here, prints a machine-readable result line
 * and is easy to update (see types.ts MARIMO_MIN_CODE_MODE_VERSION).
 */

/** Escape a string for embedding in a Python triple-quoted block, where only backslashes and the triple-quote need escaping. */
function pyTripleQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
}

/** A marker the snippets print so the tool layer can distinguish an operation's result from notebook stdout. */
export const CODE_MODE_MARKER = "__SCOOTER_MARIMO__";

/** Add a new cell to the notebook graph without running it, printing `<marker> {"ok":true,"cell_id":"..."}`. */
export function createCellSnippet(code: string, name?: string): string {
  const nameArg = name ? `, name=${JSON.stringify(name)}` : "";
  return `
import json as _json
import marimo._code_mode as _cm
async def _op():
    async with _cm.get_context() as ctx:
        # create_cell returns the CellId (a str) directly — NOT an object with
        # .cell_id (verified against the live marimo _code_mode API).
        return ctx.create_cell(r"""${pyTripleQuoted(code)}"""${nameArg})
_cid = await _op()
print("${CODE_MODE_MARKER} " + _json.dumps({"ok": True, "cell_id": str(_cid)}))
`.trim();
}

/** Queue a cell for execution, since create_cell is structural only. */
export function runCellSnippet(cellId: string): string {
  return `
import json as _json
import marimo._code_mode as _cm
async def _op():
    async with _cm.get_context() as ctx:
        ctx.run_cell(${JSON.stringify(cellId)})
        return True
await _op()
print("${CODE_MODE_MARKER} " + _json.dumps({"ok": True, "cell_id": ${JSON.stringify(cellId)}}))
`.trim();
}

/** Dump the notebook's cells, printing `<marker> {"ok":true,"cells":[{"cell_id","name","code"}...]}`. */
export function listCellsSnippet(): string {
  return `
import json as _json
import marimo._code_mode as _cm
async def _op():
    async with _cm.get_context() as ctx:
        return [
            {"cell_id": str(getattr(c, "id", "")), "name": getattr(c, "name", None), "code": getattr(c, "code", None)}
            for c in ctx.cells
        ]
_cells = await _op()
print("${CODE_MODE_MARKER} " + _json.dumps({"ok": True, "cells": _cells}))
`.trim();
}

/** Install packages into the notebook's environment via marimo's package manager, printing `<marker> {"ok":true,"installed":[...]}`. */
export function installSnippet(packages: string[]): string {
  const pkgList = JSON.stringify(packages);
  return `
import json as _json
import marimo._code_mode as _cm
async def _op():
    async with _cm.get_context() as ctx:
        pkgs = _json.loads(r"""${pyTripleQuoted(pkgList)}""")
        ctx.packages.add(*pkgs)
        return pkgs
_pkgs = await _op()
print("${CODE_MODE_MARKER} " + _json.dumps({"ok": True, "installed": _pkgs}))
`.trim();
}

/** Parse the marker line out of an execute stdout, null if the op did not complete. */
export function parseCodeModeResult(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split("\n")) {
    const i = line.indexOf(CODE_MODE_MARKER);
    if (i === -1) continue;
    const json = line.slice(i + CODE_MODE_MARKER.length).trim();
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}
