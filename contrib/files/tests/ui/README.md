# Driving the viewer's comment flow in a browser

The viewer's write half is a UI, and the bugs a reviewer hit in it — a comment button
that did nothing, a submit that lagged long enough to be pressed twice and leave two
comments, replies and deletes that did not exist — were all invisible to the pytest
suites and to the nixosTest, because neither of those clicks anything. This script
does.

It is not wired into CI yet (see the note at the bottom); it is the harness the fixes
were developed against, kept so the next change to this page can be checked the same
way rather than by eye.

From the repo root, inside `nix develop` (which exports `PW_CHROME`), after `npm ci`:

    # a viewer the script can drive, e.g. the demo web service in a sandbox
    FILES_VIEWER_URL=http://127.0.0.1:7803/c/$CONVERSATION_ID/files-demo \
    FILES_VIEWER_DOC=demo/review-me.md \
    FILES_VIEWER_BROKER=http://127.0.0.1:7900 \
      node contrib/files/tests/ui/comments.ui.mjs

`playwright` comes from the root `package.json` (it is what `@playwright/test`
installs), so there is nothing to install beside it. The script launches
`PW_CHROME` directly rather than Playwright's own browser download.

`FILES_VIEWER_DOC` must be a markdown file under the viewer's root whose prose is
hard-wrapped, which is the selection case that broke. `FILES_VIEWER_BROKER` is
optional and only for a stub broker whose store can be read back directly. The viewer
may already hold comments: counts are taken against what was there at startup, and
the comments the script writes are deleted at the end.

What it asserts, each one a bug that shipped:

- a comment appears once, in the document's margin, and not again in a side rail
- clicking the comments column beside a line opens a composer for that line, stored
  with no quote and drawn with no empty quote block
- submitting closes the composer and shows the comment immediately, with the button
  locked, so a slow round trip cannot be pressed twice into two comments
- a reply lands inside its parent's card and shares its thread
- rendered blocks carry their source line, and the "+" offered beside a hovered block
  survives the pointer's reach for it
- a line comment leaves a tick in the margin that adds no text to the document;
  pressing it lights the comment and its card, and that survives a redraw
- the column headers end on one line
- the cards sit beside the text they are about: none above its own anchor, none
  overlapping another, the first level with its anchor
- deleting a reply keeps the comment; deleting a thread takes its replies and leaves
  other threads alone; with `FILES_VIEWER_BROKER` set, the broker ends up holding the
  survivor and none of the deleted
- a pending badge clears itself with no user action, and a stored comment carries no
  badge claiming it has been read
- no page errors, and the run leaves nothing behind

CI home: this belongs in the Playwright suite under `test/e2e`, which already has the
pinned browser and the sharding. It is kept out for now because that suite boots the
whole agent-host stack per run and this needs only the viewer and a broker stub —
wiring it in means either a lighter project in `playwright.config.ts` or a fixture
that starts `contrib/files/viewer/server.py` itself.
