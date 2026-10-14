/**
 * Transcript replay support: load a recorded NDJSON transcript and turn its raw
 * input frames into a fake that drives the real bridge, so tests run against the
 * exact shapes goose and claude emit. Fixtures live under
 * test/fixtures/transcripts/<provider>/<scenario>.ndjson.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { TranscriptEntry } from "../../src/transcript/recorder.js";
import type { SessionUpdate } from "../../src/acp/client.js";

export type { TranscriptEntry };

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "transcripts");

/** The providers we record fixtures for. */
export const PROVIDERS = ["claude", "goose"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Path to a recorded fixture, which may not exist. */
export function fixturePath(provider: Provider, scenario: string): string {
  return join(FIXTURES, provider, `${scenario}.ndjson`);
}
export function fixtureExists(provider: Provider, scenario: string): boolean {
  return existsSync(fixturePath(provider, scenario));
}
/** Providers that have a recorded fixture for a scenario. */
export function providersWith(scenario: string): Provider[] {
  return PROVIDERS.filter((p) => fixtureExists(p, scenario));
}
/** Scenarios recorded for every provider. */
export function scenariosForAllProviders(): string[] {
  const byProvider = PROVIDERS.map((p) => {
    const dir = join(FIXTURES, p);
    return existsSync(dir) ? new Set(readdirSync(dir).filter((f) => f.endsWith(".ndjson")).map((f) => f.replace(/\.ndjson$/, ""))) : new Set<string>();
  });
  const [first, ...rest] = byProvider;
  return [...(first ?? new Set())].filter((s) => rest.every((set) => set.has(s))).sort();
}
/** Load a scenario's fixture for a provider. */
export function loadFixture(provider: Provider, scenario: string): TranscriptEntry[] {
  return loadTranscript(fixturePath(provider, scenario));
}

/** Parse an NDJSON transcript into ordered entries. */
export function loadTranscript(path: string): TranscriptEntry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TranscriptEntry);
}

/** The raw input entries (acp-in / sdk-in) in record order. */
export function inputEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((e) => e.layer === "acp-in" || e.layer === "sdk-in");
}

/** The AG-UI output the bridge produced for this transcript. */
export function aguiOutEntries(entries: TranscriptEntry[]): unknown[] {
  return entries.filter((e) => e.layer === "agui-out").map((e) => e.data);
}

/** The recorded goose ACP sessionUpdate frames, for the fake ACP agent to emit. */
export function acpUpdates(entries: TranscriptEntry[]): SessionUpdate[] {
  return entries.filter((e) => e.layer === "acp-in").map((e) => e.data as SessionUpdate);
}

/** The recorded raw claude SDK query() messages, for a fake query() to yield. */
export function sdkMessages(entries: TranscriptEntry[]): unknown[] {
  return entries.filter((e) => e.layer === "sdk-in").map((e) => e.data);
}

/** All assistant text the bridge emitted for a scenario, concatenated from the agui-out layer. */
export function assistantText(provider: Provider, scenario: string): string {
  const out = aguiOutEntries(loadFixture(provider, scenario)) as Array<{ type?: string; delta?: string }>;
  return out.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta ?? "").join("");
}

/**
 * Re-derive the SessionUpdate type names a scenario produces under the current code
 * from its recorded input layer. claude sdk-in runs through the real
 * `sdkMessageToUpdates`; goose acp-in frames are already normalized SessionUpdates.
 */
export async function derivedUpdateTypes(provider: Provider, scenario: string): Promise<string[]> {
  const entries = loadFixture(provider, scenario);
  if (provider === "goose") {
    return acpUpdates(entries).map((u) => (u as { sessionUpdate?: string }).sessionUpdate ?? "?");
  }
  const { sdkMessageToUpdates } = await import("@scooter/claude-sdk-provider");
  const out: string[] = [];
  for (const msg of sdkMessages(entries)) {
    for (const u of sdkMessageToUpdates(msg as never, true)) out.push((u as { sessionUpdate?: string }).sessionUpdate ?? "?");
  }
  return out;
}

/** A fake SDK query() replaying recorded claude messages verbatim, a drop-in for createSdkAcpClient's `queryImpl` that records calls and honors interrupt(). */
export function replaySdkQuery(messages: unknown[]) {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  let interrupted = false;
  const queryImpl = (params: { prompt: string; options: Record<string, unknown> }) => {
    calls.push({ prompt: params.prompt, options: params.options });
    async function* gen() {
      for (const msg of messages) {
        if (interrupted) return;
        yield msg as never;
        // Yield to the event loop so an interrupt() during this message is observed before the next one.
        await Promise.resolve();
      }
    }
    return Object.assign(gen(), { interrupt: async () => { interrupted = true; } });
  };
  return { queryImpl, calls, wasInterrupted: () => interrupted };
}
