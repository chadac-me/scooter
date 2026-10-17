// Drives the viewer's frontend (contrib/files/viewer-ui) in a real browser. The
// pytest suites and the nixosTest stop at HTTP, and every bug a reviewer has hit in
// this page lived above it: a comment button that did nothing, a submit that could
// be pressed twice into two comments, replies and deletes that did not exist.
//
// Self-contained: it starts server.py over a scratch workspace and a stub broker,
// so it needs nothing running and leaves nothing behind.
//
//   PW_CHROME=... node contrib/files/tests/ui/viewer.ui.mjs
//
// PW_CHROME is the pinned browser the dev shell exports. FILES_VIEWER_STATIC is the
// built frontend (default: viewer-ui/dist, so run `npm run build` there first, or
// point it at `nix build`'s output); FILES_VIEWER_PYTHON the interpreter for
// server.py (default: python3).

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const viewerDir = resolve(here, "../../viewer");
const staticDir = process.env.FILES_VIEWER_STATIC || resolve(here, "../../viewer-ui/dist");
const python = process.env.FILES_VIEWER_PYTHON || "python3";

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

// --- fixture: a workspace, a stub broker, the viewer ------------------------------

const root = mkdtempSync(join(tmpdir(), "files-ui-"));
const ws = join(root, "workspace");
mkdirSync(join(ws, "docs"), { recursive: true });
mkdirSync(join(ws, "src"), { recursive: true });

// Hard-wrapped prose is the selection case that used to anchor nowhere: the
// rendered paragraph joins its source lines, so the quote must map back across them.
const DOC = `# Review me

The viewer renders a document from the sandbox so that a reader can select a
passage of it and leave a comment the agent will see on its next turn.

A second paragraph, so that two threads have somewhere different to live.

\`\`\`python
def greet(name):
    return f"hello {name}"
\`\`\`

<!-- scooter:question id=pick kind=single -->
Which renderer should ship first?
- [ ] markdown
- [ ] code
<!-- /scooter:question -->

${Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i + 1}, so the next section starts below the fold.`).join("\n\n")}

## Later section

See [the sample](../src/sample.py), or go [back up](#review-me).

![a dot](dot.png)

${Array.from({ length: 40 }, (_, i) => `Trailing paragraph ${i + 1}, so the page can scroll the section to its top.`).join("\n\n")}
`;
writeFileSync(join(ws, "docs/review.md"), DOC);
const CODE = Array.from({ length: 12 }, (_, i) => `value_${i + 1} = ${i + 1}`).join("\n") + "\n";
writeFileSync(join(ws, "src/sample.py"), CODE);
writeFileSync(join(root, "token"), "test-token\n");
// A 1×1 PNG, so the document has an image to resolve through /api/raw.
writeFileSync(
  join(ws, "docs/dot.png"),
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
);

// The broker's annotation store, reduced to a map. PUT is slowed so the in-flight
// state is long enough to press submit twice into.
const store = new Map();
const broker = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const path = new URL(req.url, "http://x").pathname.replace(/^\/files\/annotations/, "");
    const send = (o) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (req.method === "PUT") {
      await new Promise((r) => setTimeout(r, 400));
      const rec = JSON.parse(body);
      store.set(path.slice(1), rec);
      return send({ annotation: rec });
    }
    if (req.method === "DELETE") {
      store.delete(path.slice(1));
      return send({});
    }
    if (req.method === "GET") return send({ annotations: [...store.values()] });
    return send({}); // thread resolve
  });
});
await new Promise((r) => broker.listen(0, "127.0.0.1", r));

const port = 7890 + Math.floor(Math.random() * 100);
const base = "/c/ui-test/files";
const viewer = spawn(python, [join(viewerDir, "server.py")], {
  env: {
    ...process.env,
    SCOOTER_FILES_ROOT: ws,
    SCOOTER_FILES_BASE: base,
    SCOOTER_FILES_PORT: String(port),
    SCOOTER_FILES_STATIC: staticDir,
    SCOOTER_FILES_STATE: join(root, "annotations.json"),
    BROKER_URL: `http://127.0.0.1:${broker.address().port}`,
    BROKER_TOKEN_PATH: join(root, "token"),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const url = `http://127.0.0.1:${port}${base}`;
for (let i = 0; ; i++) {
  try {
    const health = await (await fetch(`${url}/api/health`)).json();
    if (!health.frontend) throw new Error(`no built frontend at ${staticDir}`);
    break;
  } catch (err) {
    if (i > 50 || String(err).includes("frontend")) throw err;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// The viewer delivers to the broker from a background outbox, so what reaches the
// broker is polled for rather than slept on.
async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const api = async (p) => (await fetch(`${url}/api/${p}`)).json();
const notes = async (path) => (await api(`annotations?path=${encodeURIComponent(path)}`)).annotations;

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  // --- markdown: select, comment, reply, delete -----------------------------------

  await page.goto(`${url}/?path=docs/review.md`);
  await page.locator("article h1").waitFor();
  check("the document renders", (await page.locator("article h1").textContent()) === "Review me");
  // Shiki highlights after first paint.
  check("code fences are highlighted", await page.locator("article pre.shiki").waitFor({ timeout: 10_000 }).then(() => true, () => false));

  // Select the whole hard-wrapped paragraph and release, as a reader's drag would.
  const select = async (index) => {
    const para = page.locator("article p").nth(index);
    await para.scrollIntoViewIfNeeded();
    await para.evaluate((p) => {
      const r = document.createRange();
      r.selectNodeContents(p);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      p.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  };

  await select(0);
  const offer = page.getByRole("button", { name: "Comment", exact: true }).first();
  await offer.waitFor();
  await offer.click();
  const composer = page.locator("[data-comments] textarea");
  check("selecting text opens a composer", (await composer.count()) === 1);
  await composer.fill("first thought");
  const submit = page.locator("[data-comments]").getByRole("button", { name: "Comment", exact: true });
  await submit.click();
  // The broker holds PUT for 400 ms; the button must not accept a second press.
  const locked = await submit.isDisabled().catch(() => true);
  await submit.click({ timeout: 300 }).catch(() => {});
  check("the submit button is locked while in flight", locked);
  await page.locator("[data-thread]").first().waitFor();
  await page.waitForTimeout(600);
  let mine = await notes("docs/review.md");
  check("a second press leaves one comment, not two", mine.length === 1, `${mine.length} written`);
  const first = mine[0];
  check(
    "the comment anchors to the paragraph's source line",
    first?.line === 3 && first.quote.length > 10 && DOC.includes(first.quote),
    JSON.stringify(first && { line: first.line, quote: first.quote }),
  );
  check(
    "the quoted passage is painted",
    await page.evaluate(() => "highlights" in CSS && (CSS.highlights.get("comment")?.size ?? 0) === 1),
  );

  // A reply lands inside its thread, and adds no second mark in the text.
  const card = page.locator(`[data-thread="${first.thread}"]`);
  await card.getByRole("button", { name: "Reply" }).click();
  await card.locator("textarea").fill("and a reply");
  await card.getByRole("button", { name: "Reply", exact: true }).last().click();
  await card.getByText("and a reply").waitFor();
  mine = await notes("docs/review.md");
  check(
    "a reply shares its parent's thread",
    mine.length === 2 && new Set(mine.map((a) => a.thread)).size === 1,
    JSON.stringify(mine.map((a) => a.thread)),
  );
  check("a reply is one card, not two", (await page.locator("[data-thread]").count()) === 1);
  check("a reply adds no second mark", await page.evaluate(() => CSS.highlights.get("comment")?.size === 1));

  // The broker acks; the "sending" badge must clear on its own.
  await page.waitForFunction(() => !document.body.innerText.includes("sending"), null, { timeout: 10_000 }).catch(() => {});
  check("the sending badge clears with no user action", !(await page.locator("body").innerText()).includes("sending"));
  check("the broker received both", await until(() => store.size === 2), `${store.size} at the broker`);

  // A second thread elsewhere, so a delete can be shown to leave it alone.
  await select(1);
  await offer.waitFor();
  await offer.click();
  await composer.fill("second thread");
  await submit.click();
  await page.locator("[data-thread]").nth(1).waitFor();
  const cards = await page.locator("[data-thread]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
  check("the cards do not overlap", cards.length === 2 && cards[0].bottom <= cards[1].top, JSON.stringify(cards));

  // Deleting a reply keeps the comment; deleting a thread's opener takes its replies.
  await card.locator("li").nth(1).hover();
  await card.getByRole("button", { name: "Delete reply" }).click();
  await card.getByText("and a reply").waitFor({ state: "detached" });
  check("deleting a reply leaves the comment", (await notes("docs/review.md")).length === 2);
  await card.locator("li").first().hover();
  await card.getByRole("button", { name: "Delete comment" }).click();
  await card.waitFor({ state: "detached" });
  const left = await notes("docs/review.md");
  check("deleting one thread leaves the other", left.length === 1 && left[0].text === "second thread", JSON.stringify(left.map((a) => a.text)));
  check("deletes reach the broker", await until(() => store.size === 1), `${store.size} at the broker`);

  // --- questions ------------------------------------------------------------------

  const q = page.locator('[data-question="pick"]');
  await q.scrollIntoViewIfNeeded();
  await q.getByText("code", { exact: true }).click();
  await q.getByRole("button", { name: "Answer" }).click();
  await page.waitForTimeout(600);
  const asked = (await api("questions?path=docs/review.md")).questions;
  check("answering a question records it", asked[0]?.answered === true, JSON.stringify(asked[0]));

  // --- an agent edits the doc while the reader answers ----------------------------

  // The bug: lines shifted under a stale body, so every block fell back to raw text.
  const TWO = (pre) => `${pre}# Two questions

## First

<!-- scooter:question id=one kind=single -->
First?
- [ ] yes
- [ ] no
<!-- /scooter:question -->

## Second

<!-- scooter:question id=two kind=single -->
Second?
- [ ] left
- [ ] right
<!-- /scooter:question -->
`;
  writeFileSync(join(ws, "docs/two.md"), TWO(""));
  await page.goto(`${url}/?path=docs/two.md`);
  await page.locator('[data-question="two"]').waitFor();
  // The agent writes a decision in above both blocks, moving their lines.
  writeFileSync(join(ws, "docs/two.md"), TWO("Decided: ship it.\n\nMore context.\n\n"));
  const two = page.locator('[data-question="two"]');
  await two.getByText("right", { exact: true }).click();
  await two.getByRole("button", { name: "Answer" }).click();
  await page.waitForTimeout(800);
  check(
    "questions still render after the doc moves under them",
    (await page.locator("[data-question]").count()) === 2,
    `${await page.locator("[data-question]").count()} cards`,
  );
  check(
    "auto-refresh shows the agent's edit",
    await until(() => page.getByText("Decided: ship it.").isVisible(), 8000),
  );
  check("the answer survives the refresh", await until(() => two.getByText("Change", { exact: true }).isVisible(), 3000));

  // --- contents ------------------------------------------------------------------

  const toc = page.locator('nav[aria-label="Contents"]');
  check("a table of contents lists the headings", (await toc.getByRole("link").allTextContents()).join("|") === "Two questions|First|Second",
    (await toc.getByRole("link").allTextContents()).join("|"));
  await toc.getByRole("link", { name: "Second" }).click();
  check("a contents link addresses its section", new URL(page.url()).hash === "#second", page.url());
  check("narrow, the contents sit in the comment rail", (await page.locator('[data-comments] nav[aria-label="Contents"]').count()) === 1);
  await page.setViewportSize({ width: 1920, height: 900 });
  check(
    "wide, the contents get their own column",
    await until(async () => (await page.locator('[data-comments] nav[aria-label="Contents"]').count()) === 0 && (await toc.count()) === 1, 3000),
  );
  await page.setViewportSize({ width: 1440, height: 900 });

  // --- links: the address format the scooter-files skill hands out ---------------

  await page.goto(`${url}/?path=docs/review.md#later-section`);
  const later = page.locator("article h2#later-section");
  check("a heading anchor in the address names its section", await later.waitFor({ timeout: 5000 }).then(() => true, () => false));
  check(
    "the section is scrolled to",
    await until(async () => {
      const box = await later.boundingBox();
      return box && box.y >= 0 && box.y < 300;
    }, 3000),
  );
  const img = page.locator("article img");
  check(
    "a document's image loads from the workspace",
    (await img.getAttribute("src"))?.includes("/api/raw?path=docs%2Fdot.png") &&
      (await until(() => img.evaluate((i) => i.complete && i.naturalWidth === 1), 3000)),
    await img.getAttribute("src"),
  );
  await page.getByRole("link", { name: "the sample" }).click();
  await page.locator('[data-column-number="1"]').waitFor();
  check(
    "a relative link opens the file in the viewer",
    new URL(page.url()).searchParams.get("path") === "src/sample.py",
    page.url(),
  );
  await page.goBack();
  await page.locator("article h1").waitFor();
  check("back returns to the document", new URL(page.url()).searchParams.get("path") === "docs/review.md", page.url());

  await page.goto(`${url}/#/docs/review.md`);
  await page.locator("article h1").waitFor();
  check(
    "an old #/<file> link still opens, and is rewritten",
    new URL(page.url()).searchParams.get("path") === "docs/review.md",
    page.url(),
  );

  // --- code: a line-range comment -------------------------------------------------

  await page.goto(`${url}/?path=src/sample.py`);
  const num = (n) => page.locator(`[data-column-number="${n}"]`);
  // Pierre lays out its rows after mount; a box read before that is null.
  await num(3).waitFor({ state: "visible" });
  await num(5).waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  const a = await num(3).boundingBox();
  const b = await num(5).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  const box = page.locator("textarea");
  await box.waitFor();
  await box.fill("about these lines");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.locator("[data-thread]").waitFor();
  const coded = (await notes("src/sample.py"))[0];
  check(
    "a range comment anchors to its first line and quotes the range",
    coded?.line === 3 && coded.quote.startsWith("value_3") && coded.quote.includes("value_5"),
    JSON.stringify(coded && { line: coded.line, quote: coded.quote }),
  );
  check("the thread renders inline under its lines", (await page.locator("[data-thread]").count()) === 1);

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (err) {
  check("the run finished", false, String(err).split("\n")[0]);
} finally {
  await browser.close();
  viewer.kill();
  broker.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
