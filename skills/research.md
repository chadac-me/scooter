---
name: research
type: knowledge
version: 1.0.0
triggers:
- research
- look into
- find out
- compare
- what are the options
- survey
- deep dive
- write a report
- state of the art
- pros and cons
---

# Researching a question (research)

Use this when the user asks you to research, compare or find out about something
and one search won't settle it. The goal is a short, cited report built from
**primary sources** you have actually read, not from search snippets or your memory.

For a single fact (a version number, an API name, a date), skip all of this:
search once, read the best result with `web_fetch`, and answer.

## 1. Plan

Before you search, write down:

- **The question** in one sentence, as the user would put it.
- **3 to 6 sub-questions** that together answer it. Each should be answerable on
  its own, e.g. "What does X cost?" or "Which of A, B and C support feature Y?".
- **What counts as a primary source** here: official docs, the spec, the
  changelog, the source code, the paper, the vendor's pricing page. Blog posts
  and forum answers are leads, not sources.

Put this plan in `/workspace/research/<topic>/plan.md`.

## 2. Fan out

For more than two sub-questions, give each one its own subagent with
`spawn_subagent` on the fast model (see the model-routing skill). Subagents run
in parallel and keep your own context free for the synthesis. Give each one:

- its sub-question, and the overall question for context;
- the primary-source rule above;
- the output file `/workspace/research/<topic>/<n>-<slug>.md`;
- the note format below.

With one or two sub-questions, do them yourself.

## 3. Read, then write notes

For each sub-question, whether yours or a subagent's:

1. Search with ONE `*_web_search` tool (see the web-search skill). Try 2 or 3
   different phrasings rather than paging through one query.
2. Open the 3 to 5 most promising **primary** sources with `web_fetch`. A search
   result or a secondary article that cites a primary source is a pointer: follow
   it and read the original.
3. Write notes in this format:

```markdown
## <sub-question>

**Answer:** one or two sentences.

- <finding>. [<source title>](<url>)
- <finding>. [<source title>](<url>)

**Confidence:** high / medium / low, and why (sources agree, single source, dated, …).
**Open:** anything you couldn't settle.
```

Every finding carries the URL it came from. If you can't cite it, leave it out
or mark it as your own inference.

Check dates. Prefer the newest primary source, and say when the newest one you
found is old.

## 4. Synthesize

When the notes are in, read them all and write `/workspace/research/<topic>/report.md`:

- **Answer first.** The direct answer to the question, with your recommendation
  if one was asked for.
- **Findings.** Organised by what the user cares about, not by sub-question,
  with inline citations. Use a table when comparing options.
- **Disagreements and gaps.** Where sources conflict, what you couldn't find,
  and what would settle it.
- **Sources.** Every URL you cited.

Keep it short enough to read in a few minutes. Cut whatever doesn't change the answer.

## 5. Hand it over

Send the user a link to `report.md` in the files viewer (see the scooter-files
skill), and give a two- or three-sentence summary in chat. If the report should
outlive the sandbox, publish it with scooter-publish as well.

## Don'ts

- Don't answer from search snippets alone. A snippet is not something you read.
- Don't query every search index for the same thing. Pick one and fall back only
  if it fails.
- Don't present one source's claim as settled fact. Say who claims it.
- Don't let subagents write the final report. You own the synthesis.
