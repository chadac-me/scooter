/** `/chat/<id>` parsing: only that exact shape names a conversation, and never a path-unsafe id. */

import { describe, it, expect } from "vitest";

import { appPathFor, chatPath, chatRouteId } from "./chatRoute.js";

const ID = "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff";

describe("chatRouteId", () => {
  it("reads the conversation id from /chat/<id>, with or without a trailing slash", () => {
    expect(chatRouteId(`/chat/${ID}`)).toBe(ID);
    expect(chatRouteId(`/chat/${ID}/`)).toBe(ID);
  });

  it("is undefined for every other route", () => {
    for (const p of ["/", "/settings/tasks", "/chat", "/chat/", `/chat/${ID}/extra`, `/c/${ID}/marimo/`, `/x/chat/${ID}`]) {
      expect(chatRouteId(p), p).toBeUndefined();
    }
  });

  it("rejects ids that could escape a request path", () => {
    for (const p of ["/chat/..", "/chat/a%2Fb", "/chat/a%3Fb", "/chat/%E0%A4%A", "/chat/a%20b"]) {
      expect(chatRouteId(p), p).toBeUndefined();
    }
  });

  it("round-trips through chatPath", () => {
    expect(chatRouteId(chatPath(ID))).toBe(ID);
    expect(appPathFor(ID)).toBe(`/?thread=${ID}`);
  });
});
