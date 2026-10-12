/**
 * @scooter/claude-sdk-provider: the Claude Agent SDK-backed AcpClient, isolated so
 * the SDK's zod v4 peer-dep does not collide with agent-host's zod v3. See ./types.ts
 * for the boundary.
 */
export { createSdkAcpClient, type SdkAcpClientDeps } from "./sdkClient.js";
export { summarizeConversation, type SummaryTurn, type SummarizeDeps } from "./summarize.js";
export type { AcpClient, ExecBackend, ExecRequest, ExecResult, TerminalHandle } from "./types.js";
// Exported for the transcript harness, which replays recorded raw SDK messages through the live adapter.
export { sdkMessageToUpdates, type SdkMessage } from "./sdkAdapter.js";
