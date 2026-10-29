/** The header user badge (pure view): shows the signed-in user and renders nothing when the caller is anonymous. */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { UserBadgeView } from "./UserBadge.js";

describe("UserBadge", () => {
  it("renders the email when a real identity is present", () => {
    const html = renderToStaticMarkup(
      createElement(UserBadgeView, { user: { id: "u-42", email: "alice@example.com", anonymous: false } }),
    );
    expect(html).toContain("user-badge");
    expect(html).toContain("alice@example.com");
    expect(html).toContain("<svg"); // the person icon rendered (guards a dropped icon)
  });

  it("falls back to the id when there's no email", () => {
    const html = renderToStaticMarkup(
      createElement(UserBadgeView, { user: { id: "svc-account", email: null, anonymous: false } }),
    );
    expect(html).toContain("svc-account");
  });

  it("renders NOTHING when the caller is anonymous", () => {
    const html = renderToStaticMarkup(
      createElement(UserBadgeView, { user: { id: "anonymous", email: null, anonymous: true } }),
    );
    expect(html).toBe("");
  });
});
