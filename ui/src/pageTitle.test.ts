/**
 * Tab-title rules: the bare wordmark until a conversation has a real title, the
 * "scooter - <title>" form once it does, and the sync that follows the selection.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { APP_NAME, displayTitle, installTitleSync, pageTitle } from "./pageTitle.js";
import { sessionStore } from "./sessions.js";

beforeEach(() => {
  globalThis.localStorage?.clear?.();
  sessionStore.clearEditing();
});

describe("pageTitle", () => {
  it("is the lowercase wordmark alone with no conversation title", () => {
    expect(pageTitle()).toBe("scooter");
    expect(APP_NAME).toBe("scooter");
  });

  it("appends ' - <title>' once the conversation has one", () => {
    expect(pageTitle("Fix the login redirect")).toBe("scooter - Fix the login redirect");
  });

  it("treats the New chat placeholder and whitespace as no title", () => {
    expect(pageTitle("New chat")).toBe("scooter");
    expect(pageTitle("   ")).toBe("scooter");
    expect(displayTitle("New chat")).toBeUndefined();
    expect(displayTitle(" Fix it ")).toBe("Fix it");
  });
});

describe("installTitleSync", () => {
  // The unit suite runs without a DOM, so the sync writes into a stand-in for document.
  const tab = () => ({ title: "" });

  it("follows the selected conversation's title, and stops once uninstalled", () => {
    sessionStore.mergeFromServer([{ id: "c1", title: "Fix the login redirect" }]);
    sessionStore.requestSelect("c1");

    const doc = tab();
    const uninstall = installTitleSync(doc);
    expect(doc.title).toBe("scooter - Fix the login redirect");

    sessionStore.renameSession("c1", "Ship the parser");
    expect(doc.title).toBe("scooter - Ship the parser");

    uninstall();
    sessionStore.renameSession("c1", "Something else");
    expect(doc.title).toBe("scooter - Ship the parser");
  });

  it("drops back to the bare wordmark on a brand-new conversation", () => {
    sessionStore.mergeFromServer([{ id: "c2", title: "Fix the login redirect" }]);
    sessionStore.requestSelect("c2");
    const doc = tab();
    const uninstall = installTitleSync(doc);
    expect(doc.title).toBe("scooter - Fix the login redirect");

    sessionStore.newSession();
    expect(doc.title).toBe("scooter");
    uninstall();
  });
});
