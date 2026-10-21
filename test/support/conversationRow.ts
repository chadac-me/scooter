/**
 * Read a conversation's `conversations` row (agent_host database) from a live cluster, the
 * source of truth for its placement now that there is no Conversation CR. It runs psql inside
 * the in-cluster `agent-shared-db` pod over the local socket, where the image trusts the
 * superuser, so no credentials are needed.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type ConversationRow = {
  host_pod: string | null;
  host_generation: number;
  phase: string | null;
  sandbox_ref: string | null;
};

/** The row for `id`, or undefined when there is none. */
export async function getConversationRow(ns: string, id: string): Promise<ConversationRow | undefined> {
  // The id is interpolated into SQL, so accept only the shapes the router mints.
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error(`refusing to query an unexpected conversation id: ${id}`);
  const sql =
    "SELECT json_build_object('host_pod', host_pod, 'host_generation', host_generation, " +
    `'phase', phase, 'sandbox_ref', sandbox_ref) FROM conversations WHERE id = '${id}'`;
  const { stdout } = await execFileP("kubectl", [
    "exec", "-n", ns, "deploy/agent-shared-db", "-c", "postgres", "--",
    "psql", "-U", "postgres", "-d", "agent_host", "-tAc", sql,
  ]);
  const line = stdout.trim();
  return line ? (JSON.parse(line) as ConversationRow) : undefined;
}

/** Poll the row until `predicate` holds, throwing with the last row seen on timeout. */
export async function waitForConversationRow(
  ns: string,
  id: string,
  predicate: (row: ConversationRow) => boolean,
  timeoutMs = 90_000,
): Promise<ConversationRow> {
  const deadline = Date.now() + timeoutMs;
  let last: ConversationRow | undefined;
  while (Date.now() < deadline) {
    last = await getConversationRow(ns, id).catch(() => undefined);
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`conversations row ${id} did not match within ${timeoutMs}ms; last: ${JSON.stringify(last)}`);
}
