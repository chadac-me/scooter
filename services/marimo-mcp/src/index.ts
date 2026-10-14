/**
 * @scooter/marimo-mcp: MCP tools for driving a running marimo notebook from the agent,
 * registered onto an McpServer that the agent-host mounts into its MCP endpoint. The
 * tools target one marimo server, the conversation's in-pod marimo, which the agent-host
 * resolves per request; this module only needs a MarimoClient.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { createMarimoClient, type MarimoClient } from "./client.js";
import { createMarimoTools, type MarimoToolsOptions } from "./tools.js";
import type { MarimoTarget } from "./types.js";

/** The one method called on the MCP server, structural so a different copy of @modelcontextprotocol/sdk still satisfies it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface McpServerLike {
  // `any` args let either SDK copy's McpServer satisfy this; the per-call Zod schemas and tests carry correctness.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTool(...args: any[]): unknown;
}

export { createMarimoClient, type MarimoClient } from "./client.js";
export { createMarimoTools, type MarimoTools, type MarimoToolsOptions, type ToolResult } from "./tools.js";
export * from "./types.js";

/** Common notebook-selector args, both optional, for targeting one of several open notebooks. */
const selectorShape = {
  file: z.string().optional().describe("Target a specific notebook by its file path, when several are open."),
  session: z.string().optional().describe("Target a specific marimo session id (advanced; goes stale on browser reconnect — prefer `file`)."),
};

/** Register the marimo notebook tools on an McpServer; `clientFor` is a thunk yielding the current conversation's client, since the pod IP changes across suspend/resume. */
export function registerMarimoTools(
  server: McpServerLike,
  clientFor: () => MarimoClient | Promise<MarimoClient>,
  optionsFor?: () => MarimoToolsOptions | Promise<MarimoToolsOptions>,
): void {
  const tools = async () => createMarimoTools(await clientFor(), optionsFor ? await optionsFor() : {});
  // The SDK's CallToolResult carries an index signature ToolResult does not, so cast at the seam.
  type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; [x: string]: unknown };
  const asMcp = <T>(p: Promise<T>) => p as unknown as Promise<McpResult>;
  // Cast the call to sidestep the concrete SDK's stricter generic inference.
  const reg = server.registerTool.bind(server) as (n: string, c: unknown, h: unknown) => unknown;

  reg(
    "marimo_execute",
    {
      title: "Run Python in the marimo notebook",
      description:
        "Run Python in the running marimo notebook's scratchpad and return stdout + the last expression's value. " +
        "Use this for exploration, computing results, and building up analysis the user watches live. Prefer this " +
        "over run_shell for data/compute work — a marimo notebook is persistent, visible, and re-runnable. Requires " +
        "the marimo web service to be running (start it first).",
      inputSchema: { code: z.string().describe("Python source to execute in the notebook kernel."), ...selectorShape },
    },
    async (args: { code: string; file?: string; session?: string }) => asMcp((await tools()).execute(args)),
  );

  reg(
    "marimo_list_sessions",
    {
      title: "List open marimo notebooks",
      description: "List the marimo notebooks currently open on the running server (id + file path).",
      inputSchema: {},
    },
    async () => asMcp((await tools()).listSessions()),
  );

  reg(
    "marimo_create_cell",
    {
      title: "Add a cell to the marimo notebook",
      description:
        "Add a NEW cell to the notebook (a persistent, named cell the user sees — not scratchpad). Optionally run it. " +
        "Use this to build up a notebook the user keeps, vs marimo_execute for one-off scratchpad runs. " +
        "(Uses marimo's code-mode API; needs marimo >= 0.21.1.)",
      inputSchema: {
        code: z.string().describe("Python source for the new cell."),
        name: z.string().optional().describe("Optional cell name (for reference/reruns)."),
        run: z.boolean().optional().describe("Run the cell after creating it (create is structural only)."),
        ...selectorShape,
      },
    },
    async (args: { code: string; name?: string; run?: boolean; file?: string; session?: string }) => asMcp((await tools()).createCell(args)),
  );

  reg(
    "marimo_run_cell",
    {
      title: "Run a marimo notebook cell",
      description: "Explicitly run a cell by id (from marimo_list_cells / marimo_create_cell). Needs marimo >= 0.21.1.",
      inputSchema: { cell_id: z.string().describe("The cell id to run."), ...selectorShape },
    },
    async (args: { cell_id: string; file?: string; session?: string }) => asMcp((await tools()).runCell(args)),
  );

  reg(
    "marimo_list_cells",
    {
      title: "List the marimo notebook's cells",
      description: "List the notebook's cells (id, name, code) so you can target one to run or reference. Needs marimo >= 0.21.1.",
      inputSchema: { ...selectorShape },
    },
    async (args: { file?: string; session?: string }) => asMcp((await tools()).listCells(args)),
  );

  reg(
    "marimo_install",
    {
      title: "Install Python packages in the notebook",
      description:
        "Install Python packages into the running notebook's environment (e.g. numpy, matplotlib, pandas) so " +
        "you can import them in marimo_execute / cells. Uses marimo's package manager (uv-backed), so science " +
        "deps with native libraries work. Call this BEFORE importing a package that isn't already available.",
      inputSchema: {
        packages: z.array(z.string()).describe('Package specs to install, e.g. ["matplotlib", "numpy>=2"].'),
        ...selectorShape,
      },
    },
    async (args: { packages: string[]; file?: string; session?: string }) => asMcp((await tools()).install(args)),
  );
}

/** Build a standalone McpServer wired to a fixed marimo target, for when the target is known up front. */
export function createMarimoMcpServer(target: MarimoTarget): McpServer {
  const server = new McpServer({ name: "marimo", version: "0.0.0" });
  registerMarimoTools(server, () => createMarimoClient(target));
  return server;
}
