// Drives the viewer in a real browser. Every bug the reviewer hit (a dead comment
// button, a lagging submit that duplicated comments, no delete, no replies) was
// invisible to HTTP-level checks, so this is the layer that has to assert them.
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

const browser = await chromium.launch({ executablePath: BROWSER, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

await page.goto(DOC, { waitUntil: "networkidle" });

// --- 1. the rail sits immediately left of the document --------------------------
const boxes = await page.evaluate(() => {
  const r = (sel) => {
    const b = document.querySelector(sel)?.getBoundingClientRect();
    return b && { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) };
  };
  return { tree: r("nav#tree"), rail: r("#rail"), doc: r("main > section") };
});
check(
  "rail is between the tree and the document",
  boxes.tree.right <= boxes.rail.left + 1 && boxes.rail.right <= boxes.doc.left + 1,
  `tree ${boxes.tree.left}-${boxes.tree.right}, rail ${boxes.rail.left}-${boxes.rail.right}, doc ${boxes.doc.left}-${boxes.doc.right}`,
);

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

const countAnnotations = async () => {
  const r = await fetch(`${BASE}/api/annotations?path=${encodeURIComponent(DOC_PATH)}`);
  return (await r.json()).annotations.length;
};

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
check("a second press leaves one comment, not two", (await countAnnotations()) === 1, `${await countAnnotations()} stored`);
await page.unroute("**/api/annotations");

// --- 3. replying ----------------------------------------------------------------
await page.waitForSelector("#clist .ann .replybox textarea");
await page.fill("#clist .ann .replybox textarea", "A reply, under the comment it answers.");
await page.click("#clist .ann .replybox button[type=submit]");
await page.waitForFunction(() => document.querySelectorAll("#clist .ann .reply").length === 1, null, { timeout: 8000 });
const threaded = await page.evaluate(() => ({
  cards: document.querySelectorAll("#clist .ann").length,
  replies: document.querySelectorAll("#clist .ann .reply").length,
  marks: document.querySelectorAll("#view mark.anchor").length,
}));
check("a reply lands inside its thread's card", threaded.cards === 1 && threaded.replies === 1, JSON.stringify(threaded));
check("a reply does not add a second anchor mark", threaded.marks === 1, `${threaded.marks} marks`);

const stored = await (await fetch(`${BASE}/api/annotations?path=${encodeURIComponent(DOC_PATH)}`)).json();
const threads = new Set(stored.annotations.map((a) => a.thread));
check("the reply shares its parent's thread", stored.annotations.length === 2 && threads.size === 1, `${stored.annotations.length} records, ${threads.size} thread(s)`);

// --- 4. deleting ----------------------------------------------------------------
await page.click('#clist .ann .reply .top button:text-is("delete")');
await page.waitForFunction(() => document.querySelectorAll("#clist .ann .reply").length === 0, null, { timeout: 8000 });
check("deleting a reply leaves the comment", (await countAnnotations()) === 1, `${await countAnnotations()} stored`);

// A second thread, to prove delete takes the right one.
await openComposer(1);
await page.fill("#ctext", "Second thread, on another paragraph.");
await page.click("#csubmit");
await page.waitForFunction(() => document.querySelectorAll("#clist .ann").length === 2, null, { timeout: 8000 });
await page.click('#clist .ann:first-child .top button:text-is("delete")');
await page.waitForFunction(() => document.querySelectorAll("#clist .ann").length === 1, null, { timeout: 8000 });
const left = await (await fetch(`${BASE}/api/annotations?path=${encodeURIComponent(DOC_PATH)}`)).json();
check("deleting one thread leaves the other", left.annotations.length === 1, JSON.stringify(left.annotations.map((a) => a.text)));

// --- 5. the sync badge settles on its own ---------------------------------------
// No clicking, no reload: the rail has to come back and look until the push acks.
const acked = await page
  .waitForSelector("#clist .ann .badge.acked", { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
check("the pending badge flips to acked with no user action", acked);

// Only when a stub broker is reachable: against a real broker the viewer's own view
// of what synced is the assertable half.
if (BROKER) {
  const brokerLeft = await (await fetch(`${BROKER}/files/annotations`)).json();
  check("the broker holds exactly the surviving comment", brokerLeft.annotations.length === 1, `${brokerLeft.annotations.length} at the broker`);
}

check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
