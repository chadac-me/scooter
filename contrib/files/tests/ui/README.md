# Driving the viewer's comment flow in a browser

The viewer's write half is a UI, and the three bugs a reviewer hit in it — a comment
button that did nothing, a submit that lagged long enough to be pressed twice and
leave two comments, replies and deletes that did not exist — were all invisible to
the pytest suites and to the nixosTest, because neither of those clicks anything.
This script does.

It is not wired into CI yet (see the note at the bottom); it is the harness the fixes
were developed against, kept so the next change to this page can be checked the same
way rather than by eye.

    # a viewer the script can drive, e.g. the demo web service in a sandbox
    PW_CHROME=$PW_CHROME \
    FILES_VIEWER_URL=http://127.0.0.1:7803/c/$CONVERSATION_ID/files-demo \
    FILES_VIEWER_DOC=demo/review-me.md \
    FILES_VIEWER_BROKER=http://127.0.0.1:7900 \
      node contrib/files/tests/ui/comments.ui.mjs

`PW_CHROME` is exported by the repo's dev shell. `playwright` itself is not a
dependency of this repo's npm tree yet, so install it where you run this from
(`npm i playwright@1.56.1`); `FILES_VIEWER_DOC` must be a markdown file under the
viewer's root whose prose is hard-wrapped, which is the selection case that broke.
`FILES_VIEWER_BROKER` is optional and only for a stub broker whose store can be read
back directly.

What it asserts, each one a bug that shipped:

- the rail is between the tree and the document, not out past its right edge
- submitting closes the composer and shows the comment immediately, with the button
  locked, so a slow round trip cannot be pressed twice into two comments
- a reply lands inside its parent's card, shares its thread, and does not add a
  second anchor mark in the text
- deleting a reply keeps the comment; deleting a thread takes its replies and leaves
  other threads alone, at the viewer and at the broker
- a pending badge clears itself with no user action, and a stored comment carries no
  badge claiming it has been read
- the quote highlight is painted rather than merely present, and a commented
  paragraph still reads as the file does
- the "+" offered beside a hovered block survives the pointer's reach for it
- the cards sit in the document's margin, beside the text they are about, without
  overlapping each other or rising above their own anchor

CI home: this belongs in the Playwright suite under `test/e2e`, which already has the
pinned browser and the sharding. It is kept out for now because that suite boots the
whole agent-host stack per run and this needs only the viewer and a broker stub —
wiring it in means either a lighter project in `playwright.config.ts` or a fixture
that starts `contrib/files/viewer/server.py` itself.
