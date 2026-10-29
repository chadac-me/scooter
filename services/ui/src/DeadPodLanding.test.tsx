/** The "starting" spinner shown while an explicit Sandbox-tab Start is in flight. */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StartingPodLanding } from "./DeadPodLanding.js";

describe("StartingPodLanding", () => {
  it("shows a spinner + 'starting' copy", () => {
    const html = renderToStaticMarkup(createElement(StartingPodLanding));
    expect(html).toContain('data-testid="starting-pod-landing"');
    expect(html.toLowerCase()).toContain("starting");
  });
});
