// One shared state-stream connection per conversation, and its topic readers.

import { useEffect, useRef, useState } from "react";

import { openSSE, type SSESubscription } from "./sseClient.js";
import { currentConversation, useSessions } from "./sessions.js";
import { pollWhileVisible } from "./visiblePoll.js";

/** A topic without `data` means "changed, refetch". */
export type StateFrame = { kind: "topic"; topic: string; data?: unknown } | { kind: "synced" };

export type TopicEvent =
  | { kind: "data"; data: unknown }
  | { kind: "invalidate" }
  | { kind: "open" }
  | { kind: "down" };

type Reader = (e: TopicEvent) => void;

interface Channel {
  sub: SSESubscription;
  readers: Map<string, Set<Reader>>;
  /** Last pushed value per topic, for readers mounting later. */
  values: Map<string, unknown>;
  connected: boolean;
}

export interface StateStreamDeps {
  fetchImpl?: typeof fetch;
  staleAfterMs?: number;
}

/** Open channels, keyed by state-stream URL. */
export function createStateChannels(deps: StateStreamDeps = {}) {
  const channels = new Map<string, Channel>();

  const each = (ch: Channel, fn: (r: Reader) => void, topic?: string) => {
    const sets = topic === undefined ? [...ch.readers.values()] : [ch.readers.get(topic) ?? new Set<Reader>()];
    for (const set of sets) for (const r of [...set]) fn(r);
  };

  const open = (url: string): Channel => {
    const ch: Channel = { sub: { close() {} }, readers: new Map(), values: new Map(), connected: false };
    ch.sub = openSSE<StateFrame>(
      url,
      {
        onOpen() {
          ch.connected = true;
          each(ch, (r) => r({ kind: "open" }));
        },
        onDown() {
          if (!ch.connected) return;
          ch.connected = false;
          each(ch, (r) => r({ kind: "down" }));
        },
        onFrame(f) {
          if (f.kind !== "topic") return;
          if (f.data === undefined) {
            ch.values.delete(f.topic);
            each(ch, (r) => r({ kind: "invalidate" }), f.topic);
          } else {
            ch.values.set(f.topic, f.data);
            each(ch, (r) => r({ kind: "data", data: f.data }), f.topic);
          }
        },
      },
      { fetchImpl: deps.fetchImpl, staleAfterMs: deps.staleAfterMs, label: "conversationState" },
    );
    return ch;
  };

  return {
    /** The reader hears the kept value first; returns the unsubscribe. */
    subscribe(url: string, topic: string, reader: Reader): () => void {
      let ch = channels.get(url);
      if (!ch) {
        ch = open(url);
        channels.set(url, ch);
      }
      let set = ch.readers.get(topic);
      if (!set) ch.readers.set(topic, (set = new Set()));
      set.add(reader);
      if (ch.values.has(topic)) reader({ kind: "data", data: ch.values.get(topic) });
      if (ch.connected) reader({ kind: "open" });
      const mine = ch;
      return () => {
        const s = mine.readers.get(topic);
        s?.delete(reader);
        if (s && s.size === 0) mine.readers.delete(topic);
        if (mine.readers.size > 0) return;
        mine.sub.close();
        if (channels.get(url) === mine) channels.delete(url);
      };
    },
    size: () => channels.size,
  };
}

const shared = createStateChannels();

export interface TopicOptions<T> {
  /** Runs on connect and on every invalidation. */
  load?: () => Promise<T>;
  /** Poll `load` this often while the stream is down. */
  fallbackPollMs?: number;
}

export type StateChannels = ReturnType<typeof createStateChannels>;

/** Follow one topic; `opts` is read per use, so loaders may change. */
export function watchTopic<T>(
  channels: StateChannels,
  url: string,
  topic: string,
  opts: () => TopicOptions<T>,
  onValue: (value: T) => void,
  poll: typeof pollWhileVisible = pollWhileVisible,
): () => void {
  let alive = true;
  // A newer value outranks any load still in flight.
  let seq = 0;
  const load = () => {
    const fn = opts().load;
    if (!fn) return;
    const mine = ++seq;
    void fn().then(
      (value) => {
        if (alive && mine === seq) onValue(value);
      },
      () => {
        /* keep the last value; the next invalidation or reconnect retries */
      },
    );
  };
  let stopPoll: (() => void) | undefined;
  const stopFallback = () => {
    stopPoll?.();
    stopPoll = undefined;
  };
  const startFallback = () => {
    const { fallbackPollMs, load: fn } = opts();
    if (!fallbackPollMs || !fn || stopPoll) return;
    stopPoll = poll(load, fallbackPollMs);
  };

  let connected = false;
  const unsub = channels.subscribe(url, topic, (e) => {
    if (!alive) return;
    if (e.kind === "data") {
      seq++;
      onValue(e.data as T);
    } else if (e.kind === "invalidate") {
      load();
    } else if (e.kind === "open") {
      connected = true;
      stopFallback();
      load();
    } else {
      connected = false;
      startFallback();
    }
  });
  // Not yet connected: read now, and poll if it never connects.
  if (!connected) {
    load();
    startFallback();
  }
  return () => {
    alive = false;
    stopFallback();
    unsub();
  };
}

/** A state-stream topic of the open conversation. */
export function useConversationTopic<T>(
  topic: string,
  opts: TopicOptions<T> = {},
  channels: StateChannels = shared,
): T | undefined {
  useSessions(); // re-render when the server id arrives
  const url = currentConversation()?.url("/state/events");
  const [value, setValue] = useState<T | undefined>(undefined);
  // Fresh closures each render must not re-subscribe.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    setValue(undefined);
    if (!url) return;
    return watchTopic<T>(channels, url, topic, () => optsRef.current, (v) => setValue(() => v));
  }, [url, topic, channels]);

  return value;
}
