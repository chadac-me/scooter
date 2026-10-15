"""Question fields parsed out of a document's markdown.

The author's source of truth is the file, so the parser's job is to find what a human
wrote and refuse to invent anything else. The trap the design names explicitly — a
`scooter:question` block shown as an example inside a code fence becoming a live field
— is the first thing pinned here.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))

import questions as q  # noqa: E402


ONE = """# Design

Some prose.

<!-- scooter:question id=q1 kind=single -->
Which renderer ships first?
- [ ] markdown
- [x] diff
<!-- /scooter:question -->

Closing prose.
"""


def test_a_block_becomes_a_field_with_its_options():
    (field,) = q.parse(ONE)

    assert field["id"] == "q1"
    assert field["kind"] == "single"
    assert field["prompt"] == "Which renderer ships first?"
    assert [o["label"] for o in field["options"]] == ["markdown", "diff"]
    # The author's own checkmark is carried through, so a doc that already records a
    # leaning shows it rather than presenting the choice as untouched.
    assert [o["checked"] for o in field["options"]] == [False, True]
    # The line the block opens on, which is what the gutter aligns a card to.
    assert field["line"] == 5


def test_a_block_inside_a_fence_is_an_example_not_a_field():
    doc = """# Docs

How to ask a question:

```
<!-- scooter:question id=example kind=multi -->
Shown, never asked.
- [ ] a
<!-- /scooter:question -->
```

<!-- scooter:question id=real kind=text -->
The only live one.
<!-- /scooter:question -->
"""
    assert [f["id"] for f in q.parse(doc)] == ["real"]


def test_a_tilde_fence_and_an_indented_fence_hide_a_block_too():
    doc = """~~~markdown
<!-- scooter:question id=tilde kind=text -->
no
<!-- /scooter:question -->
~~~

- a list item:

      <!-- scooter:question id=indented kind=text -->
      no
      <!-- /scooter:question -->

<!-- scooter:question id=live kind=text -->
yes
<!-- /scooter:question -->
"""
    assert [f["id"] for f in q.parse(doc)] == ["live"]


def test_an_unclosed_fence_swallows_the_rest_of_the_document():
    # Honest over eager: inside an unterminated fence everything is example text, and
    # guessing where the author meant it to end is how a doc grows a question nobody
    # asked.
    doc = """```
<!-- scooter:question id=q1 kind=text -->
no
<!-- /scooter:question -->
"""
    assert q.parse(doc) == []


def test_text_kind_carries_no_options():
    doc = """<!-- scooter:question id=q1 kind=text -->
What should the default be?
<!-- /scooter:question -->
"""
    (field,) = q.parse(doc)
    assert field["kind"] == "text"
    assert field["options"] == []


def test_a_block_with_no_kind_is_single_and_a_bad_kind_is_refused():
    doc = """<!-- scooter:question id=q1 -->
Pick one.
- [ ] a
<!-- /scooter:question -->

<!-- scooter:question id=q2 kind=wat -->
Pick none.
<!-- /scooter:question -->
"""
    fields = q.parse(doc)
    # The default is the narrowest kind, and an unknown kind is dropped rather than
    # rendered as a control the reader cannot use.
    assert [(f["id"], f["kind"]) for f in fields] == [("q1", "single")]


def test_a_block_with_no_id_is_dropped():
    # The id is how an answer finds its question, so a block without one has nowhere
    # to store a reply.
    doc = """<!-- scooter:question kind=text -->
Who am I?
<!-- /scooter:question -->
"""
    assert q.parse(doc) == []


def test_an_unclosed_block_is_dropped_and_does_not_eat_the_next_one():
    doc = """<!-- scooter:question id=q1 kind=text -->
Never closed.

<!-- scooter:question id=q2 kind=text -->
Closed.
<!-- /scooter:question -->
"""
    assert [f["id"] for f in q.parse(doc)] == ["q2"]


def test_a_duplicate_id_keeps_the_first_and_drops_the_rest():
    # Two blocks with one id cannot both be answered, and silently answering the wrong
    # one is worse than ignoring the copy.
    doc = """<!-- scooter:question id=q1 kind=text -->
First.
<!-- /scooter:question -->

<!-- scooter:question id=q1 kind=text -->
Second.
<!-- /scooter:question -->
"""
    fields = q.parse(doc)
    assert [f["prompt"] for f in fields] == ["First."]


def test_attributes_tolerate_quotes_and_extra_space():
    doc = """<!--   scooter:question   id="q 1"  kind='multi'   -->
Prompt.
- [ ] a
<!--  /scooter:question  -->
"""
    (field,) = q.parse(doc)
    assert field["id"] == "q 1"
    assert field["kind"] == "multi"


def test_a_multi_line_prompt_keeps_its_prose_and_its_options():
    doc = """<!-- scooter:question id=q1 kind=multi -->
Which ones?

Any number, including none.
- [ ] a — with a dash in the label
- [X] b
<!-- /scooter:question -->
"""
    (field,) = q.parse(doc)
    assert field["prompt"] == "Which ones?\n\nAny number, including none."
    assert [(o["label"], o["checked"]) for o in field["options"]] == [
        ("a — with a dash in the label", False),
        ("b", True),
    ]


def test_an_option_list_without_checkboxes_is_still_a_list_of_options():
    doc = """<!-- scooter:question id=q1 kind=single -->
Pick one.
- markdown
- diff
<!-- /scooter:question -->
"""
    (field,) = q.parse(doc)
    assert [(o["label"], o["checked"]) for o in field["options"]] == [
        ("markdown", False),
        ("diff", False),
    ]


def test_only_markdown_is_scanned():
    # A .py file containing the marker in a string is code, not a questionnaire.
    assert q.parse_if_markdown(ONE, "docs/design.md")
    assert q.parse_if_markdown(ONE, "viewer/server.py") == []


@pytest.mark.parametrize("name", ["design.md", "design.markdown", "README.MD"])
def test_markdown_suffixes_are_recognised(name):
    assert q.parse_if_markdown(ONE, f"docs/{name}")


# --- over HTTP ------------------------------------------------------------------

import json  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))

from test_viewer_annotations import viewer  # noqa: E402


DOC_WITH_FIELDS = """# Design

<!-- scooter:question id=q1 kind=single -->
Which first?
- [ ] a
- [ ] b
<!-- /scooter:question -->

<!-- scooter:question id=q2 kind=text -->
Why?
<!-- /scooter:question -->
"""


def test_questions_are_served_with_their_answers_and_their_own_counts(tmp_path: Path):
    with viewer(tmp_path, doc=DOC_WITH_FIELDS, name="design.md") as (call, _store):
        status, body = call("GET", "/api/questions?path=design.md")
        assert status == 200
        assert [f["id"] for f in body["questions"]] == ["q1", "q2"]
        # Nothing answered yet, and the rail's two numbers are kept apart.
        assert body["counts"]["questions"] == 2
        assert body["counts"]["open"] == 2
        assert body["counts"]["comments"] == 0

        call(
            "POST",
            "/api/annotations",
            {
                "path": "design.md",
                "line": 3,
                "quote": "Which first?",
                "text": "a",
                "kind": "answer",
                "question_id": "q1",
            },
        )

        _, after = call("GET", "/api/questions?path=design.md")
        answered = {f["id"]: f for f in after["questions"]}
        assert answered["q1"]["answered"] is True
        assert [a["text"] for a in answered["q1"]["answers"]] == ["a"]
        assert answered["q2"]["answered"] is False
        # One of the two is still blocking the agent, and the answer is not a comment.
        assert after["counts"]["open"] == 1
        assert after["counts"]["comments"] == 0


def test_a_file_with_no_fields_asks_nothing(tmp_path: Path):
    with viewer(tmp_path) as (call, _store):
        _, body = call("GET", "/api/questions?path=doc.md")
        assert body == {"questions": [], "counts": {"comments": 0, "pending": 0, "stale": 0, "questions": 0, "open": 0}}


def test_the_questions_route_is_read_only(tmp_path: Path):
    with viewer(tmp_path) as (call, _store):
        assert call("POST", "/api/questions?path=doc.md", {})[0] == 405


def test_the_tab_count_and_the_list_under_it_are_the_same_set(tmp_path: Path):
    with viewer(tmp_path, doc=DOC_WITH_FIELDS, name="design.md") as (call, store):
        call("POST", "/api/annotations", {"path": "design.md", "line": 1, "quote": "Design", "text": "here"})
        # A thread on another file must not inflate this document's number.
        store.add(content="elsewhere\n", path="other.md", line=1, quote="elsewhere", text="there")

        _, body = call("GET", "/api/annotations?path=design.md")
        assert body["counts"]["comments"] == len(body["annotations"]) == 1
