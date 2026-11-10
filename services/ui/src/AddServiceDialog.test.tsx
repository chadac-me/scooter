/** The Add service form: what it accepts, and the request it sends Scooter. */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { addServiceError, addServicePrompt, type AddServiceForm } from "./AddServiceDialog.js";
import { SandboxPanelView } from "./SandboxPanel.js";

const form = (over: Partial<AddServiceForm> = {}): AddServiceForm => ({
  name: "dashboard",
  purpose: "A Streamlit dashboard for app.py",
  command: "",
  port: "",
  start: true,
  ...over,
});

describe("addServiceError", () => {
  it("accepts a slug name and an unprivileged port", () => {
    expect(addServiceError(form({ port: "8501" }), [])).toBeNull();
  });

  it("rejects a name that is not a slug, or already declared", () => {
    expect(addServiceError(form({ name: "My App" }), [])).toMatch(/lowercase/);
    expect(addServiceError(form({ name: "1app" }), [])).toMatch(/lowercase/);
    expect(addServiceError(form(), ["dashboard"])).toMatch(/already exists/);
  });

  it("rejects a port that is not a number in 1024–65535", () => {
    for (const port of ["80", "70000", "abc"]) expect(addServiceError(form({ port }), [])).toMatch(/port/);
  });
});

describe("addServicePrompt", () => {
  it("names the service, its purpose and the option to declare", () => {
    const p = addServicePrompt(form());
    expect(p).toContain("- Name: `dashboard`");
    expect(p).toContain("- What it serves: A Streamlit dashboard for app.py");
    expect(p).toContain("`webServices.dashboard`");
    expect(p).toContain("send me the link");
    expect(p).not.toContain("Start command");
    expect(p).not.toContain("Port");
  });

  it("includes the optional command and port, and can leave the service stopped", () => {
    const p = addServicePrompt(form({ command: "streamlit run app.py", port: "8501", start: false }));
    expect(p).toContain("- Start command: `streamlit run app.py`");
    expect(p).toContain("- Port: 8501");
    expect(p).toContain("Leave it stopped");
  });
});

describe("the Services panel's Add row", () => {
  const view = (onRequestService?: (p: string) => void) =>
    renderToStaticMarkup(
      createElement(SandboxPanelView, {
        state: "running",
        services: [],
        busy: {},
        onStartSandbox: () => {},
        onStartService: () => {},
        onStopService: () => {},
        onRequestService,
      }),
    );

  it("shows only when the panel can send a request", () => {
    expect(view(() => {})).toContain('data-testid="service-add"');
    expect(view()).not.toContain('data-testid="service-add"');
  });
});
