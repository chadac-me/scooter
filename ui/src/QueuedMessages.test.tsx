/** The inline queued-messages list renders the durable queue from RuntimeProvider context, which rides the integrity stream. */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueuedMessages } from "./QueuedMessages.js";
import { InterruptContext, type InterruptContextValue } from "./RuntimeProvider.js";

function render(queuedMessages: InterruptContextValue["queuedMessages"]): string {
  const value = {
    interrupts: [],
    submitResume: async () => {},
    conversationId: "c1",
    baseUrl: "",
    isRunning: true,
    cancel: async () => {},
    cancelState: "idle",
    runError: null,
    queuedMessages,
    renderTick: 0,
  } as InterruptContextValue;
  return renderToStaticMarkup(createElement(InterruptContext.Provider, { value }, createElement(QueuedMessages)));
}

describe("QueuedMessages", () => {
  it("renders nothing when the queue is empty", () => {
    expect(render([])).toBe("");
  });

  it("renders each queued message", () => {
    const html = render([
      { id: "q1", text: "first queued", priority: 0 },
      { id: "q2", text: "second queued", priority: 0 },
    ]);
    expect(html).toContain('data-testid="queued-messages"');
    expect(html).toContain("first queued");
    expect(html).toContain("second queued");
    expect(html.match(/data-testid="queued-message"/g)).toHaveLength(2);
  });

  it("marks a priority message distinctly and floats it to the top", () => {
    const html = render([
      { id: "q1", text: "normal one", priority: 0 },
      { id: "q2", text: "urgent one", priority: 10 },
    ]);
    // The priority message carries the pill + priority flag.
    expect(html).toContain('data-testid="queued-priority-pill"');
    expect(html).toContain('data-priority="true"');
    // Only one row is a priority row.
    expect(html.match(/data-priority="true"/g)).toHaveLength(1);
    // The priority row sorts first.
    expect(html.indexOf("urgent one")).toBeLessThan(html.indexOf("normal one"));
  });

  it("wraps long messages instead of truncating (no page-stretching)", () => {
    const html = render([{ id: "q1", text: "x".repeat(400), priority: 0 }]);
    // The message wraps rather than forcing one line.
    expect(html).toContain("break-words");
    expect(html).not.toContain("truncate");
  });

  it("clamps a message to a few lines (Show more/less appears once it overflows)", () => {
    // The text is line-clamped by default; the overflow measurement and the toggle are DOM-only.
    const html = render([{ id: "q1", text: "line\n".repeat(20), priority: 0 }]);
    expect(html).toContain("line-clamp-6");
  });

  it("renders as a faded user bubble with a progress spinner and status", () => {
    const html = render([{ id: "q1", text: "waiting", priority: 0 }]);
    expect(html).toContain("opacity-60");
    expect(html).toContain("animate-spin");
    expect(html).toContain('data-testid="queued-message-status"');
    expect(html).toContain("Queued");
  });

  it("labels a not-yet-acknowledged optimistic send as Sending", () => {
    const html = render([{ id: "optimistic-abc", text: "just sent", priority: 0 }]);
    expect(html).toContain("Sending…");
  });

  it("labels a priority message as interrupting", () => {
    const html = render([{ id: "q1", text: "stop that", priority: 10 }]);
    expect(html).toContain("Interrupting current turn");
  });
  it("renders a queued system message as the collapsed system-event line, not a user bubble", () => {
    const html = render([
      { id: "q1", text: "PR #12 was approved\n".repeat(40), priority: 0, source: "github" },
      { id: "q2", text: "user words", priority: 0 },
    ]);
    // Both are queued rows, but the system one uses the shared SystemEventMessage renderer.
    expect(html.match(/data-testid="queued-message"/g)).toHaveLength(2);
    expect(html).toContain('data-role="system-queued"');
    expect(html).toContain('data-slot="aui_system-message"');
    expect(html).toContain('data-source="github"');
    expect(html).toContain('data-pending="true"');
    expect(html).toContain('data-testid="system-event-status"');
    expect(html).toContain("Queued");
    // Collapsed: the body is not rendered, and only the user message gets a bubble.
    expect(html).not.toContain('data-testid="system-event-body"');
    expect(html.match(/data-testid="queued-message-text"/g)).toHaveLength(1);
  });
});
