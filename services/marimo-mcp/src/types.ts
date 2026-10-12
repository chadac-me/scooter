/**
 * The marimo control protocol, as spoken by a running `marimo edit --no-token` server:
 *   GET  {base}/api/sessions          -> { "<sessionId>": SessionInfo, ... }
 *   POST {base}/api/kernel/execute    -> an SSE stream (see ExecuteEvent), with the
 *        header `Marimo-Session-Id: <id>` and body `{ code }`.
 * Structural cell ops run marimo's `marimo._code_mode` inside the kernel through the
 * execute endpoint and are pinned to MARIMO_MIN_CODE_MODE_VERSION.
 */

/** The marimo release that shipped the `marimo._code_mode` cell API, which the cell tools require. */
export const MARIMO_MIN_CODE_MODE_VERSION = "0.21.1";

/** One entry in `GET /api/sessions`, keyed by session id in the response object. */
export interface SessionInfo {
  /** The notebook file's path, stable across browser reconnects. */
  path?: string;
  filename?: string;
}

/** The parsed result of a scratchpad execution, folded from the SSE stream. */
export interface ExecuteResult {
  /** True unless the `done` frame reported `success: false`. */
  success: boolean;
  /** Concatenated `event: stdout` data. */
  stdout: string;
  /** Concatenated `event: stderr` data, where Python tracebacks land. */
  stderr: string;
  /** The `done` frame's `output.data`, the representation of the last expression. */
  output: string;
}

/** Marimo's SSE frames on the execute stream, parsed into ExecuteResult. */
export type ExecuteEvent =
  | { event: "stdout"; data: string }
  | { event: "stderr"; data: string }
  | { event: "done"; success: boolean; output: string };

/** How the client reaches one marimo server: base URL plus an optional bearer token for a token-guarded server. */
export interface MarimoTarget {
  /** The pod IP plus marimo port with no trailing slash, e.g. `http://10.1.2.3:2718`. */
  baseUrl: string;
  token?: string;
}

/** Thrown for a protocol-level failure, carrying a machine-readable `kind` for the tool layer. */
export class MarimoError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "no-session"
      | "multiple-sessions"
      | "http-error"
      | "incomplete-stream"
      | "unreachable",
  ) {
    super(message);
    this.name = "MarimoError";
  }
}
