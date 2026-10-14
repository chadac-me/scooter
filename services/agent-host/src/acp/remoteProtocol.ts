/**
 * ACP-over-WebSocket wire protocol for bring-your-own-Claude. The user's container runs
 * the Claude Agent SDK and dials an outbound WS to the cloud; the cloud's RemoteAcpClient
 * drives it over that WS while the agent's tools still exec into the cloud sandbox.
 * Channels are multiplexed on one WS as JSON `{ch, type, id?, payload}` frames, where
 * `id` correlates a request to its reply: channel A carries ACP (cloud → agent
 * initialize/new_session/prompt/cancel/kill_terminals, agent → cloud
 * session_update/terminal_created/permission_request, plus `ack` replies), channel B the
 * reverse exec tunnel (exec_run/exec_spawn/fs_read/fs_write answered by
 * exec_result/exec_chunk/exec_exit), and channel C the MCP tunnel. The token and the
 * inference call live entirely in the container; the cloud only ever sees these frames.
 */

import type {
  ContentBlock,
  InitializeParams,
  NewSessionParams,
  PermissionRequest,
  SessionUpdate,
} from "./client.js";

/** The protocol version, bumped on any wire change; the connect handshake rejects a mismatch. */
export const REMOTE_PROTOCOL_VERSION = 1;

export type Channel = "acp" | "exec" | "tunnel";

/** Every wire frame; `id` is present on request/reply pairs and absent on one-way notifications. */
export interface WireFrame<P = unknown> {
  ch: Channel;
  type: string;
  id?: string;
  /** The ACP session this frame belongs to, stamped by the container so the relay routes it to the matching in-flight run when one container serves concurrent conversations. */
  sid?: string;
  payload: P;
}

// --- Channel A: ACP (cloud → agent requests, each answered by an `ack` reply) ----------------
export type AcpDownType = "initialize" | "new_session" | "prompt" | "cancel" | "kill_terminals";

export interface AcpInitializePayload {
  params: InitializeParams;
}
export interface AcpNewSessionPayload {
  params: NewSessionParams;
}
export interface AcpPromptPayload {
  sessionId: string;
  prompt: ContentBlock[];
}
export interface AcpCancelPayload {
  sessionId: string;
}

/** The reply to an ACP request (`type: "ack"`, same `id`), whose `result` shape follows the request (initialize {protocolVersion}, new_session {sessionId}, prompt {stopReason}, cancel/kill_terminals {}), or `error` when the agent failed the call. */
export interface AcpAckPayload {
  result?: unknown;
  error?: string;
}

// --- Channel A: ACP (agent → cloud notifications) --------------------------------------------
export interface AcpSessionUpdatePayload {
  sessionId: string;
  update: SessionUpdate;
}
export interface AcpTerminalCreatedPayload {
  terminalId: string;
  command: string;
  args: string[];
}
/** A permission request from the agent, which blocks until the cloud replies with an `ack` carrying {optionId} or {cancelled:true}. */
export interface AcpPermissionRequestPayload {
  request: PermissionRequest;
}
export interface AcpPermissionAnswerPayload {
  optionId?: string;
  cancelled?: boolean;
}

// --- Channel B: exec tunnel (agent → cloud requests, run on the cloud ExecBackend) --
export type ExecUpType = "exec_run" | "exec_spawn" | "fs_read" | "fs_write";

export interface ExecRunPayload {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}
export interface FsReadPayload {
  path: string;
}
export interface FsWritePayload {
  path: string;
  content: string;
}

/** The reply to an exec/fs request (`type: "exec_result"`, same `id`): the ExecResult for exec_run/spawn, {content} for fs_read, {} for fs_write, or `error`; streaming spawn output arrives as one-way `exec_chunk` frames terminated by `exec_exit`. */
export interface ExecResultPayload {
  result?: unknown;
  error?: string;
}
export interface ExecChunkPayload {
  streamId: string;
  chunk: string;
}
export interface ExecExitPayload {
  streamId: string;
  exitCode: number;
}

// --- Transport abstraction ---------------
/** A minimal duplex frame transport: the WS in prod, an in-memory pair in tests. */
export interface RemoteTransport {
  /** Send one frame to the peer; throws or no-ops if closed, so the caller's request times out. */
  send(frame: WireFrame): void;
  /** Subscribe to inbound frames from the peer, returning an unsubscribe fn. */
  onFrame(cb: (frame: WireFrame) => void): () => void;
  /** Whether the underlying connection is currently open. */
  isOpen(): boolean;
  /** Notified when the connection closes. */
  onClose(cb: () => void): () => void;
  /** Close the transport. */
  close(): void;
}

/** The connect handshake the container sends before any ACP frame; the cloud verifies both fields before accepting it into the registry. */
export interface RemoteConnectHello {
  protocolVersion: number;
  joinToken: string;
}

// --- Channel C: tunnel (MCP over the wire, BYOC only) ---------------------------------------
// A named-target bidirectional stream mux, not a raw TCP tunnel: `target` is a server name
// the agent-host resolves server-side, the container runs one local HTTP proxy per offered
// server, and `open` starts a stream, `chunk` flows both ways, and `close` ends it, always
// with a reason on failure.
export type TunnelType = "open" | "chunk" | "end" | "close";

/** container -> cloud: start a stream to a named target. */
export interface TunnelOpenPayload {
  /** The server name, resolved server-side, never a host:port. */
  target: string;
  method: string;
  /** Path + query as the local proxy received it (e.g. "/" or "/messages?x=1"). */
  path: string;
  headers: Record<string, string>;
}

/** container -> cloud: the request body is complete, while the response may still stream back. */
export type TunnelEndPayload = Record<string, never>;

/** Either direction: a body chunk, base64 for binary safety. */
export interface TunnelChunkPayload {
  data: string;
}

/** Either direction: the stream is over, with `error` set when it failed. */
export interface TunnelClosePayload {
  error?: string;
  /** cloud -> container, on the first frame of a response. */
  status?: number;
  headers?: Record<string, string>;
}
