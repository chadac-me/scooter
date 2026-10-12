/** The queued-messages strip renders the durable queue from RuntimeProvider context, which rides the integrity stream. */

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
    expect(html).toContain("line-clamp-4");
  });
});
