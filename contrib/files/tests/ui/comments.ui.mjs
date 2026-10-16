// Drives the viewer in a real browser. Every bug a reviewer has hit in this page —
// a dead comment button, a lagging submit that duplicated comments, no replies, no
// delete, comments shown twice in two columns — was invisible to the HTTP-level
// tests, because none of them click anything. This is the layer that has to assert
// them.
//
// It runs against a viewer that may already hold comments (a demo someone has been
// using), so every count here is measured against a baseline taken at startup and
// the records it writes are cleaned up at the end.
import { chromium } from "playwright";

// PW_CHROME is the pinned browser the dev shell exports; FILES_VIEWER_URL is the
// base a running viewer is served under, and FILES_VIEWER_DOC a markdown file in its
// root whose prose is hard-wrapped (the selection case that used to anchor nowhere).
const BROWSER = process.env.PW_CHROME;
const BASE = process.env.FILES_VIEWER_URL;
const DOC_PATH = process.env.FILES_VIEWER_DOC ?? "demo/review-me.md";
const BROKER = process.env.FILES_VIEWER_BROKER ?? "";
const DOC = `${BASE}/?path=${encodeURIComponent(DOC_PATH)}`;
if (!BROWSER || !BASE) {
  console.error("set PW_CHROME and FILES_VIEWER_URL (see contrib/files/tests/ui/README.md)");
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const annotations = async () =>
  (await (await fetch(`${BASE}/api/annotations?path=${encodeURIComponent(DOC_PATH)}`)).json()).annotations;

const browser = await chromium.launch({ executablePath: BROWSER, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

await page.goto(DOC, { waitUntil: "networkidle" });

// What was already here. Everything below counts from these, so a demo someone has
// been leaving comments in is a valid place to run.
const before = new Set((await annotations()).map((a) => a.id));
const mine = async () => (await annotations()).filter((a) => !before.has(a.id));
const baseCards = await page.$$eval("#clist .ann", (n) => n.length);
const cards = (n) => page.waitForFunction((want) => document.querySelectorAll("#clist .ann").length === want, baseCards + n, { timeout: 8000 });

// --- 1. one place per thing -----------------------------------------------------
// Comments used to be in the left rail *and* the document's right margin, saying
// everything twice. They are now in the margin only -- inside the document's own
// column, on the same paper, immediately right of the text.
const boxes = await page.evaluate(() => {
  const r = (sel) => {
    const b = document.querySelector(sel)?.getBoundingClientRect();
    return b && { left: Math.round(b.left), right: Math.round(b.right) };
  };
  return {
    tree: r("nav#tree"), rail: r("#rail"), doc: r("main > section"),
    text: r("#view .md, #view .codewrap"), cpane: r("#cpane"), gutter: r("#gutter"),
    stray: document.querySelectorAll(".ann").length - document.querySelectorAll("#cpane .ann").length,
    bg: getComputedStyle(document.querySelector("#cpane")).backgroundColor,
  };
});
check(
  "tree, conversation, text, comments — in that order",
  boxes.tree.right <= boxes.rail.left + 1 && boxes.rail.right <= boxes.doc.left + 1 && boxes.text.right <= boxes.cpane.left + 1,
  `tree ${boxes.tree.left}-${boxes.tree.right}, rail ${boxes.rail.left}-${boxes.rail.right}, text ${boxes.text.left}-${boxes.text.right}, comments ${boxes.cpane.left}-${boxes.cpane.right}`,
);
check(
  "the margin is inside the document's column, not a column of its own",
  boxes.cpane.left >= boxes.doc.left && boxes.cpane.right <= boxes.doc.right + 1 && boxes.bg === "rgba(0, 0, 0, 0)",
  `doc ${boxes.doc.left}-${boxes.doc.right}, margin ${boxes.cpane.left}-${boxes.cpane.right}, background ${boxes.bg}`,
);
// The margin begins where the prose ends. A wide window used to leave a gutter of
// empty page between a sentence and the card about it, and the reader matched them
// up by reading both.
check(
  "the comments start beside the text, not across the page",
  boxes.cpane.left - boxes.text.right < 40,
  `${boxes.cpane.left - boxes.text.right}px between the text and the first card`,
);
check("a comment is in the margin and nowhere else", !boxes.gutter && boxes.stray === 0, `${boxes.stray} card(s) outside the margin`);

try {
  // Clicking the comments column itself picks the line beside the click.
  const spot = await page.evaluate(() => {
    const body = document.getElementById("cbody");
    const pane = body.getBoundingClientRect();
    const x = Math.round(pane.left + pane.width - 24);
    // Free space in the margin, found by looking down the visible column: the cards
    // are placed against the text they are about, so the gaps between them are
    // wherever the document has nothing commented on. Clicking a card is the reader
    // working on that comment, not asking for a new one.
    let y = null;
    for (let probe = Math.round(Math.max(pane.top, 0)) + 12; probe < Math.min(pane.bottom, window.innerHeight) - 12; probe += 8) {
      const at = document.elementFromPoint(x, probe);
      if (at && body.contains(at) && !at.closest(".ann, #cform, .cbar")) { y = probe; break; }
    }
    if (y === null) return null;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !body.contains(hit) || hit.closest(".ann, #cform, .cbar")) return null;
    // The line this point is beside, worked out here rather than asked of the page:
    // the nearest block by vertical distance is the whole rule being tested.
    let best = null;
    for (const block of document.querySelectorAll("#view .md [data-line]")) {
      const box = block.getBoundingClientRect();
      const gap = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
      if (!best || gap < best.gap) best = { gap, line: Number(block.dataset.line) };
    }
    return best && { line: best.line, x, y };
  });
  check("the comments column has empty space beside the text to click", !!spot, JSON.stringify(spot));
  await page.mouse.click(spot.x, spot.y);
  await page.waitForSelector("#cform", { state: "visible" });
  const where = await page.textContent("#cwhere");
  check("clicking the comments column comments on the line beside it", where === `line ${spot.line}`, `${where}, expected line ${spot.line}`);
  await page.click("#ccancel");

  // Select a whole rendered paragraph: hard-wrapped in the source, so this is the
  // selection that used to anchor to nothing.
  async function selectParagraph(nth = 0) {
    await page.evaluate((n) => {
      const p = document.querySelectorAll("#view p")[n];
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }, nth);
    await page.waitForSelector("#selbar", { state: "visible" });
  }

  async function openComposer(nth = 0) {
    await selectParagraph(nth);
    await page.click("#selcomment");
    await page.waitForSelector("#cform", { state: "visible" });
  }

  // --- 2. a slow submit neither lags nor duplicates --------------------------------
  await page.route("**/api/annotations", async (route) => {
    if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  await openComposer(0);
  await page.fill("#ctext", "First comment — does the button answer at once?");
  await page.click("#csubmit");
  // Immediately, with the POST still in flight: composer closed, comment on screen.
  const instant = await page.evaluate(() => ({
    formVisible: getComputedStyle(document.getElementById("cform")).display !== "none",
    sending: !!document.querySelector(".ann.sending"),
    disabled: document.getElementById("csubmit").disabled,
  }));
  check("submit closes the composer and shows the comment at once", !instant.formVisible && instant.sending, JSON.stringify(instant));
  check("the submit button is locked while in flight", instant.disabled);

  // Press again, the way a reader does when nothing seems to happen.
  await page.evaluate(() => document.getElementById("csubmit").click());
  await page.evaluate(() => document.getElementById("cform").dispatchEvent(new Event("submit", { cancelable: true })));
  await page.waitForFunction(() => !document.querySelector(".ann.sending"), null, { timeout: 8000 });
  check("a second press leaves one comment, not two", (await mine()).length === 1, `${(await mine()).length} written`);
  await page.unroute("**/api/annotations");

  // --- 3. replying ----------------------------------------------------------------
  const parent = (await mine())[0].thread;
  const card = `#clist .ann[data-thread="${parent}"]`;
  await page.waitForSelector(`${card} .replybox textarea`);
  await page.fill(`${card} .replybox textarea`, "A reply, under the comment it answers.");
  await page.click(`${card} .replybox button[type=submit]`);
  await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .reply`).length === 1, card, { timeout: 8000 });
  const threaded = await page.evaluate((sel) => ({
    cards: document.querySelectorAll("#clist .ann").length,
    replies: document.querySelectorAll(`${sel} .reply`).length,
  }), card);
  check("a reply lands inside its thread's card, not beside it", threaded.cards === baseCards + 1 && threaded.replies === 1, JSON.stringify(threaded));
  const written = await mine();
  const threads = new Set(written.map((a) => a.thread));
  check("the reply shares its parent's thread", written.length === 2 && threads.size === 1, `${written.length} records, ${threads.size} thread(s)`);
  const painted = await page.evaluate(() => {
    const m = document.querySelector("mark.qmark");
    if (!m) return null;
    const cs = getComputedStyle(m);
    return { opacity: cs.opacity, display: cs.display, visibility: cs.visibility, text: m.textContent };
  });
  check(
    "the quote highlight is actually painted, not invisible",
    painted && painted.opacity === "1" && painted.display === "inline" && painted.visibility === "visible",
    JSON.stringify(painted && { ...painted, text: painted.text.slice(0, 24) }),
  );

  // Every marked paragraph still says what the file says. Checked against the file's
  // own bytes rather than a hard-coded sentence, so it holds for whichever paragraph
  // the run commented on: a mark that hides or eats text leaves a paragraph that is
  // no longer a substring of the source.
  // Inline markdown is stripped from both sides: the renderer turns `failed` into
  // failed, which is a difference in syntax, not in words.
  const plain = (text) => text.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
  const source = (await (await fetch(`${BASE}/api/file?path=${encodeURIComponent(DOC_PATH)}`)).json()).body;
  const flat = plain(source);
  const paras = await page.$$eval("#view p", (nodes) =>
    nodes.filter((n) => n.querySelector("mark.qmark")).map((n) => n.textContent));
  const orphan = paras.map(plain).find((text) => !flat.includes(text));
  check(
    "every commented paragraph still reads as the file does",
    paras.length > 0 && !orphan,
    orphan ? `lost text: "${orphan.slice(0, 60)}…"` : `${paras.length} marked paragraph(s) intact`,
  );

  const marks = await page.$$eval("#view mark.qmark", (nodes) => nodes.map((n) => n.dataset.thread));
  check(
    "a reply does not add a second anchor mark",
    marks.filter((t) => t === parent).length === 1,
    `${marks.filter((t) => t === parent).length} marks for this thread, ${marks.length} in the file`,
  );

  // --- 4. commenting on a line, with no quote --------------------------------------
  // The other way in: a reader who wants to mark a paragraph rather than quote a
  // phrase out of it. The "+" follows the block under the pointer.
  const target = await page.evaluate(() => {
    const block = [...document.querySelectorAll("#view .md [data-line]")].find((b) => b.tagName === "P");
    return block ? { line: Number(block.dataset.line), text: block.textContent.slice(0, 30) } : null;
  });
  check("rendered blocks carry their source line", !!target, JSON.stringify(target));
  await page.hover("#view .md p[data-line]");
  await page.waitForSelector("#linebtn", { state: "visible", timeout: 4000 });

  // Reaching the "+" means crossing the margin between the text and the button, and a
  // hand crosses it in small moves. page.click() teleports the pointer onto the
  // element and so passes even when the button cannot be reached by hand: this walks
  // the whole way in ~4px steps, which is how the offer was found to vanish at the
  // paragraph's right edge and never come back.
  const from = await page.evaluate(() => {
    const b = document.querySelector("#view .md p[data-line]").getBoundingClientRect();
    return { x: b.x + 120, y: b.y + b.height - 6 };
  });
  await page.mouse.move(from.x, from.y, { steps: 5 });
  const to = await page.evaluate(() => {
    const b = document.querySelector("#linebtn").getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  const steps = Math.max(2, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 4));
  let lost = 0;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    if (await page.$eval("#linebtn", (n) => getComputedStyle(n).display === "none")) lost++;
  }
  check("the + survives the reach for it", lost === 0, `hidden at ${lost}/${steps} points on the way`);

  // Pressed where the pointer already is, rather than by selector: a button that is
  // only clickable after a teleport is not clickable.
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForSelector("#cform", { state: "visible" });
  const composer = await page.evaluate(() => ({
    where: document.getElementById("cwhere").textContent,
    quoteShown: getComputedStyle(document.getElementById("cquote")).display !== "none",
  }));
  check("the composer anchors to the line and quotes nothing", composer.where === `line ${target.line}` && !composer.quoteShown, JSON.stringify(composer));
  await page.fill("#ctext", "A comment on the line, not on a quote.");
  await page.click("#csubmit");
  await cards(2);
  const lineRecord = (await mine()).find((a) => a.text.startsWith("A comment on the line"));
  check("a line comment is stored against the line with no quote", lineRecord?.line === target.line && lineRecord.quote === "", JSON.stringify(lineRecord && { line: lineRecord.line, quote: lineRecord.quote }));
  const emptyQuotes = await page.$$eval("#clist .ann blockquote", (nodes) => nodes.filter((n) => !n.textContent.trim()).length);
  check("a quoteless comment draws without an empty blockquote", emptyQuotes === 0, `${emptyQuotes} empty`);

  // A line comment quotes nothing, so it has no highlight -- and until the tick it
  // left no trace in the document at all: the card was in the margin and the
  // paragraph it was about looked untouched.
  const tick = await page.evaluate((line) => {
    const block = document.querySelector(`#view .md [data-line="${line}"]`);
    const t = block?.querySelector(".cmark");
    if (!t) return null;
    const b = block.getBoundingClientRect(), r = t.getBoundingClientRect();
    return { label: t.title, left: Math.round(r.left - b.left), inText: t.textContent.length, threads: (block.dataset.threads || "").split(" ").length };
  }, target.line);
  check("a line comment leaves a tick in the margin", !!tick && tick.left < 0, JSON.stringify(tick));
  check("the tick adds no text to the document", tick && tick.inText === 0, `${tick?.inText} characters`);

  // The tick is the way back to the comment: pressing it lights the thread in the
  // document and its card in the margin together.
  await page.click(`#view .md [data-line="${target.line}"] .cmark`);
  await page.waitForTimeout(250);
  const lit = await page.evaluate(() => ({
    tick: !!document.querySelector("#view .cmark.focus"),
    card: !!document.querySelector("#clist .ann.focus"),
  }));
  check("pressing the tick lights the comment and its card", lit.tick && lit.card, JSON.stringify(lit));


  // The rule under the column headers is one line across the window. Each header is a
  // separate element that used to be sized by its own padding and content, so the
  // three ended within a few pixels of each other -- close enough to look like a
  // rendering fault rather than a layout one.
  // Two headers now, not three: the comments have no bar of their own since they
  // moved into the document's margin, and their count sits in the file bar.
  const heads = await page.evaluate(() =>
    ["#tabs", ".filebar"]
      .map((sel) => { const n = document.querySelector(sel); return n ? { sel, bottom: +n.getBoundingClientRect().bottom.toFixed(2) } : null; })
      .filter(Boolean));
  const spread = Math.max(...heads.map((h) => h.bottom)) - Math.min(...heads.map((h) => h.bottom));
  check("the column headers end on one line", heads.length === 2 && spread < 0.5, `${spread.toFixed(2)}px apart: ${JSON.stringify(heads)}`);

  // Each card is placed against the text it is about: at the top of its quote, or
  // pushed down by the card above it, but never above its own anchor -- a card over
  // the paragraph before it would point at the wrong text.
  const placed = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#cpane .ann")].map((c) => {
      const t = c.dataset.thread;
      const mark = t ? document.querySelector(`mark.qmark[data-thread="${CSS.escape(t)}"]`) : null;
      // The block a comment's line falls inside, which is the block that opened at
      // or before it -- a comment can be on the third line of a paragraph.
      const want = Number(c.dataset.line || 0);
      let block = null;
      for (const b of document.querySelectorAll("#view [data-line]")) {
        const at = Number(b.dataset.line);
        if (at <= want && (!block || at > Number(block.dataset.line))) block = b;
      }
      const a = (mark || block)?.getBoundingClientRect();
      const b = c.getBoundingClientRect();
      return { line: c.dataset.line, top: Math.round(b.top), bottom: Math.round(b.bottom), drift: a ? Math.round(b.top - a.top) : null };
    }).sort((x, y) => x.top - y.top);
    let overlap = 0;
    for (let i = 1; i < cards.length; i++) if (cards[i].top < cards[i - 1].bottom - 1) overlap++;
    return { cards, overlap, above: cards.filter((c) => c.drift !== null && c.drift < -1).length };
  });
  check("no card sits above the text it is about", placed.above === 0, `${placed.above} of ${placed.cards.length} above their anchor`);
  check("the cards do not overlap each other", placed.overlap === 0, `${placed.overlap} overlapping pair(s)`);
  check("the first card is level with its own anchor", placed.cards[0] && placed.cards[0].drift !== null && placed.cards[0].drift <= 2, JSON.stringify(placed.cards[0]));

  // --- 5. deleting ----------------------------------------------------------------
  await page.click('#clist .ann .reply .top button:text-is("delete")');
  await page.waitForFunction(() => document.querySelectorAll("#clist .ann .reply").length === 0, null, { timeout: 8000 });
  check("deleting a reply leaves the comment", (await mine()).length === 2, `${(await mine()).length} left`);

  const doomed = (await mine()).find((a) => a.text.startsWith("First comment"));
  await page.click(`#clist .ann[data-thread="${doomed.thread}"] .top button:text-is("delete")`);
  await cards(1);
  const left = await mine();
  check("deleting one thread leaves the other", left.length === 1 && left[0].id === lineRecord.id, JSON.stringify(left.map((a) => a.text)));

  // --- 6. the sync badge settles on its own ---------------------------------------
  // No clicking, no reload: the page has to come back and look until the push lands,
  // and then the badge goes. A stored comment is the ordinary case and says nothing
  // -- there is no "acked", which on a card beside the agent's own document would
  // read as the agent having seen it.
  const settled = await page
    .waitForFunction(() => {
      const cards = [...document.querySelectorAll("#clist .ann")];
      return cards.length > 0 && !cards.some((c) => c.querySelector(".badge.pending, .badge.sending"));
    }, null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("the pending badge clears itself once the comment is out", settled);
  const claims = await page.$$eval("#clist .ann .badge", (n) => n.map((b) => b.textContent));
  check("a stored comment claims nothing about being read", !claims.includes("acked"), claims.join(", ") || "no badges");

  // Only when a stub broker is reachable: against a real broker the viewer's own view
  // of what synced is the assertable half.
  if (BROKER) {
    // Polled, not read once: the push and the delete are queued work, so a single
    // read races them and fails on a slow machine while the viewer is behaving.
    const brokerIds = async () =>
      new Set((await (await fetch(`${BROKER}/files/annotations`)).json()).annotations.map((a) => a.id));
    let held = await brokerIds();
    for (let i = 0; i < 40 && !(held.has(lineRecord.id) && !held.has(doomed.id)); i++) {
      await new Promise((r) => setTimeout(r, 250));
      held = await brokerIds();
    }
    check(
      "the broker holds the surviving comment and forgot the deleted ones",
      held.has(lineRecord.id) && !held.has(doomed.id),
      `${held.size} at the broker`,
    );
  }

  check("no page errors", errors.length === 0, errors.join(" | "));

} catch (err) {
  check("the run finished", false, String(err).split("\n")[0]);
} finally {
  // Left as it was found, pass or fail: records from a crashed run are what break
  // the next one.
  for (const a of await mine()) await fetch(`${BASE}/api/annotations/${a.id}`, { method: "DELETE" });
  check("the test cleaned up after itself", (await mine()).length === 0);
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
