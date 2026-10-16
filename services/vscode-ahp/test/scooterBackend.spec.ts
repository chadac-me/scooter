import { describe, expect, it } from "vitest";
import { ScooterBackend, type AguiEvent, type ScooterApi } from "../src/scooterBackend.js";
import { ProtocolCore } from "../src/vendor/hydra-ahp/protocol/core.js";
import type { ActionRequest } from "../src/vendor/hydra-ahp/protocol/backend.js";

const CONV = "6c5b0a0c-887e-4328-929f-43f3e727c162";
const SESSION = `scooter:/${CONV}`;
const chatOf = (s: string) => "ahp-chat://default/" + Buffer.from(s, "utf8").toString("base64url");

/** A fake router: `emit` feeds the live event stream; history is whatever was emitted before start. */
function fakeApi(history: AguiEvent[] = []) {
  let sink: ((ev: AguiEvent) => void) | undefined;
  const sent: string[] = [];
  let cancels = 0;
  const api: ScooterApi = {
    async stream(onEvent, signal) {
      for (const ev of history) onEvent(ev);
      sink = onEvent;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    },
    async sendMessage(text) { sent.push(text); },
    async cancel() { cancels++; },
  };
  return { api, sent, cancels: () => cancels, emit: (...evs: AguiEvent[]) => evs.forEach((e) => sink!(e)) };
}

async function setup(history: AguiEvent[] = []) {
  const fake = fakeApi(history);
  const backend = new ScooterBackend({ conversationId: CONV, conversationUrl: "https://scooter.example/?thread=x", api: fake.api });
  const core = new ProtocolCore({ backend, detachGraceMs: 0 });
  await core.start();
  await new Promise((r) => setTimeout(r, 0)); // let the pump replay history
  const chat = (session = SESSION) => core.store.state(chatOf(session)) as any;
  /** What the core does for a client dispatch: ask the backend, then apply the accepted action. */
  const dispatch = async (channel: string, action: Record<string, unknown>) => {
    const req = { channel, action, origin: { clientId: "vscode", clientSeq: 1 }, client: { clientId: "vscode", version: "0.9.0" } } as unknown as ActionRequest;
    const d = await backend.handleAction(req);
    if (d.accept) core.publish(channel, action as never, req.origin);
    return d;
  };
  return { ...fake, backend, core, chat, dispatch };
}

const user = (id: string, text: string): AguiEvent[] => [
  { type: "TEXT_MESSAGE_START", messageId: id, role: "user" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text },
  { type: "TEXT_MESSAGE_END", messageId: id },
];
const say = (id: string, text: string): AguiEvent[] => [
  { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text },
  { type: "TEXT_MESSAGE_END", messageId: id },
];
const tool = (id: string, name: string, args: object, result: string): AguiEvent[] => [
  { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name },
  { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args) },
  { type: "TOOL_CALL_END", toolCallId: id },
  { type: "TOOL_CALL_RESULT", toolCallId: id, messageId: `${id}-r`, content: result },
];
const run = (runId: string, ...evs: AguiEvent[][]): AguiEvent[] => [
  { type: "RUN_STARTED", threadId: CONV, runId },
  ...evs.flat(),
  { type: "RUN_FINISHED", threadId: CONV, runId },
];

describe("ScooterBackend", () => {
  it("advertises one Scooter agent usable without a GitHub sign-in", async () => {
    const { core } = await setup();
    const root = core.store.state("ahp-root://") as any;
    expect(root.agents).toHaveLength(1);
    expect(root.agents[0]).toMatchObject({ provider: "scooter", protectedResources: [] });
    expect(root.agents[0].models).toHaveLength(1); // VS Code requires a model for agent-host providers
  });

  it("lists exactly this conversation", async () => {
    const { backend } = await setup();
    const { items } = (await backend.listSessions()) as any;
    expect(items.map((s: any) => s.resource)).toEqual([SESSION]);
  });

  it("replays history into completed turns", async () => {
    const { chat } = await setup([
      ...user("u1", "list files"),
      ...run("r1", tool("t1", "mcp__sandbox__bash", { command: "ls" }, "a\nb\n"), say("m1", "Two files.")),
    ]);
    const c = chat();
    expect(c.activeTurn).toBeUndefined();
    expect(c.turns).toHaveLength(1);
    expect(c.turns[0].message.text).toBe("list files");
    expect(c.turns[0].state).toBe("complete");
    const kinds = c.turns[0].responseParts.map((p: any) => p.kind);
    expect(kinds).toEqual(["toolCall", "markdown"]);
    expect(c.turns[0].responseParts[0].toolCall.status).toBe("completed");
    expect(c.turns[0].responseParts[1].content).toBe("Two files.");
  });

  it("sends a VS Code prompt to Scooter and adopts the router's echo instead of opening a second turn", async () => {
    const { chat, dispatch, sent, emit } = await setup();
    const d = await dispatch(chatOf(SESSION), { type: "chat/turnStarted", turnId: "vs-1", startedAt: new Date().toISOString(), message: { text: "hi", origin: { kind: "user" } } });
    expect(d).toEqual({ accept: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["hi"]);
    emit(...run("r2", user("u2", "hi"), say("m2", "hello!")));
    const c = chat();
    expect(c.turns).toHaveLength(1);
    expect(c.turns[0].id).toBe("vs-1");
    expect(c.turns[0].responseParts.map((p: any) => p.content)).toEqual(["hello!"]);
  });

  it("refuses tool approvals from VS Code", async () => {
    const { dispatch } = await setup();
    const d = await dispatch(chatOf(SESSION), { type: "chat/toolCallConfirmed", turnId: "t", toolCallId: "x", approved: true });
    expect(d.accept).toBe(false);
  });

  it("shows a pending approval as a note and keeps the turn open", async () => {
    const { chat, emit } = await setup();
    emit(...user("u3", "deploy"), { type: "RUN_STARTED", threadId: CONV, runId: "r3" },
      { type: "RUN_FINISHED", threadId: CONV, runId: "r3", outcome: { type: "interrupt" } });
    const c = chat();
    expect(c.activeTurn).toBeDefined();
    expect(JSON.stringify(c.activeTurn)).toContain("Waiting for approval");
  });

  it("makes a VS Code-created session a second view of the same conversation", async () => {
    const { backend, chat, emit } = await setup([...user("u1", "earlier"), ...run("r1", say("m1", "earlier reply"))]);
    const alias = "scooter:/new-from-vscode";
    await backend.handleCommand("createSession", { channel: alias }, {} as never);
    expect(chat(alias).turns).toHaveLength(1); // history replayed into the alias
    emit(...user("u2", "later"), ...run("r2", say("m2", "later reply")));
    expect(chat(alias).turns).toHaveLength(2);
    expect(chat(SESSION).turns).toHaveLength(2);
    expect(() => backend.handleCommand("createSession", { channel: "copilotcli:/x" }, {} as never)).toThrow();
  });

  it("answers resolveSessionConfig with an empty config", async () => {
    const { backend } = await setup();
    expect(await backend.handleCommand("resolveSessionConfig", { provider: "scooter" }, {} as never)).toEqual({ schema: { type: "object", properties: {} }, values: {} });
  });

  it("forwards Stop to the router and ends the turn on CANCEL_REQUESTED", async () => {
    const { chat, emit, dispatch, cancels } = await setup();
    emit(...user("u4", "long task"), { type: "RUN_STARTED", threadId: CONV, runId: "r4" });
    const turnId = chat().activeTurn.id;
    await dispatch(chatOf(SESSION), { type: "chat/turnCancelled", turnId, duration: 1 });
    expect(cancels()).toBe(1);
    emit({ type: "CANCEL_REQUESTED", threadId: CONV, runId: "r4" }); // must not double-cancel
    expect(chat().activeTurn).toBeUndefined();
    expect(chat().turns.at(-1).state).toBe("cancelled");
  });
});
