/**
 * The agent_host database DSN assembled from the environment, shared by the service
 * (index.ts) and the event-backfill Job so both connect to the same database with the
 * same credentials. An explicit AGENT_HOST_DB_DSN wins; otherwise the DSN is built from
 * the AGENT_HOST_DB_* vars, and "" is returned when no password is present so a caller
 * can tell "not configured" from a connection failure.
 */

export function agentHostDsnFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AGENT_HOST_DB_DSN;
  if (explicit) return explicit;
  const pw = env.AGENT_HOST_DB_PASSWORD;
  if (!pw) return "";
  const host = env.AGENT_HOST_DB_HOST ?? "agent-shared-db";
  const port = env.AGENT_HOST_DB_PORT ?? "5432";
  const name = env.AGENT_HOST_DB_NAME ?? "agent_host";
  const user = env.AGENT_HOST_DB_USER ?? "agent_host";
  const sslmode = env.AGENT_HOST_DB_SSLMODE;
  const query = sslmode ? `?sslmode=${encodeURIComponent(sslmode)}` : "";
  return `postgresql://${user}:${encodeURIComponent(pw)}@${host}:${port}/${name}${query}`;
}
