import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";

import remarkDropHtmlComments from "./remarkDropHtmlComments";

const render = (md: string) =>
  renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [remarkDropHtmlComments] }, md));

describe("remarkDropHtmlComments", () => {
  it("hides a comment on its own line", () => {
    expect(render("Done.\n\n<!-- scooter:done -->")).toBe("<p>Done.</p>");
  });

  it("hides an inline comment", () => {
    expect(render("Done. <!-- scooter:done -->")).toBe("<p>Done. </p>");
  });

  it("hides a comment that is still streaming in", () => {
    expect(render("Done.\n\n<!-- scooter:do")).toBe("<p>Done.</p>");
  });

  it("leaves other raw HTML escaped, as before", () => {
    expect(render("a <b>bold</b> word")).toContain("&lt;b&gt;");
  });

  it("leaves comments in code alone", () => {
    expect(render("`<!-- x -->`")).toContain("&lt;!-- x --&gt;");
  });
});
