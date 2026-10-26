# Spec: AskUserQuestion as a contrib (contrib interrupt renderers)

Status: implemented in #912, which ships AskUserQuestion as the `ask-user` contrib from the start.

## Problem

The first cut of #912 let the agent ask the user a question and block until it was answered,
but every piece of it was core code:

| piece | where it was |
|---|---|
| the card (options, "Other", multi-select) | `ui/src/QuestionCard.tsx`, branched into by `InterruptPanel.tsx` |
| the wire keys for questions and answers | `scooter.dev/questions` / `scooter.dev/answers` in `acp/client.ts`, `questionAnswers()` in `agui/server.ts` |
| the bridge knowing a question from an approval | `reason: "input_required"` + `metadata.questions` in `bridge.ts` |
| the Claude hook that does the asking | `claude-sdk-provider/src/askUser.ts`, special-cased by tool name in `sdkClient.ts` |

A second "the agent needs something from you" interaction (pick a file, confirm a
diff, choose a branch) would mean the same five-file edit. Contribs can add
settings tabs, tool cards and approval gating today, but they **can't draw a
request in the Approvals tab**. The contrib README already says a custom renderer
"lands with the first feature that needs it". This is that feature.

The test: if someone outside core can write AskUserQuestion as
`contrib/ask-user/`, the UI is extensible.

## Proposal

Add two generic extension points to core, then move AskUserQuestion into
`contrib/ask-user/` on top of them.

### 1. A request kind on the interrupt (core)

Today an interrupt is options plus an optional free-form `metadata`. Add one field:

```ts
// AG-UI interrupt, as the bridge emits it
{ id, reason, message, toolCallId,
  metadata: { options, kind?: string, data?: unknown } }
// resume payload, as the UI sends it
{ interruptId, status, payload: { optionId, result?: unknown } }
```

- `kind` is namespaced by the owning contrib (`ask-user.questions`), the same rule
  settings-tab ids follow. A request with no `kind`, or with a kind no enabled
  contrib renders, falls back to today's option buttons. So a missing contrib
  degrades to "Answer / Dismiss", never a stuck run.
- The agent-host carries `data` and `result` **opaquely**: a size cap (say 16 KiB
  each) and a JSON-object check, nothing more. It no longer knows what a question
  is. `questionAnswers()` and the two `scooter.dev/*` keys go away in favour of
  one pair, `scooter.dev/interrupt` (`{kind, data}`) on the ACP permission request
  and `scooter.dev/interrupt-result` on its response.
- `reason` goes back to always being `confirmation`. `kind` replaces the
  `input_required` signal.
- The sidebar `!` stays as in #912, its state in the `conversation_awaiting_input` table. It fires for
  any pending request, whatever its kind.

### 2. An interrupt-renderer UI slot (core)

Declared like a settings tab:

```nix
# contrib/ask-user/contrib.nix
ui.interruptRenderers."ask-user.questions" = {
  entry = "ui/QuestionCard.tsx";
};
```

- **Manifest.** `contrib/ui-manifest.nix` emits `interruptRenderers: {kind -> entry}`.
  Eval throws on a kind not prefixed by the contrib name, a duplicate kind, or a
  missing entry (same checks as `settings-tabs.nix`).
- **Loading.** The same `import.meta.glob("../../contrib/*/ui/*.tsx")` table that
  `contribTabs.tsx` uses, so the chunk is lazy and only fetched when such a
  request is pending. A chunk that fails to load or throws shows an error card
  **with the fallback buttons still under it**, so the user can always unblock
  the agent.
- **The contract.** The default export receives:

  ```ts
  interface InterruptRendererProps {
    message: string;          // the interrupt's title
    data: unknown;            // metadata.data, unvalidated: the renderer checks its own shape
    busy: boolean;            // a resume is in flight
    resolve(result: unknown): void;  // send result back to the agent
    dismiss(): void;          // cancel; the agent sees "not answered"
  }
  ```

  It's exported from `ui/src/contrib/sdk.ts` with the components the card needs,
  and the existing ESLint boundary applies unchanged.
- `InterruptPanel` looks up `kind` in the manifest before drawing `InterruptCard`.
  The contrib-specific branch added in #912 is removed.

### 3. The contrib's agent half

The renderer is half of it; something still has to raise the request. Two cases:

- **Claude provider.** Generalize the #912 hook into a table in core:
  "tool `T` blocks on the user; send its input as `{kind: K, data: input}`; merge
  the result into `updatedInput`". The contrib declares its row:

  ```nix
  agent.blockingTools.AskUserQuestion = { kind = "ask-user.questions"; };
  ```

  That rides to the agent-host as config, and the provider reads it at start.
  The 7-day hook timeout, `dontAsk` interplay and abort handling stay in core,
  because they're properties of the hook, not of questions.
- **Goose and other ACP agents.** These have no built-in question tool. The contrib
  can ship an MCP tool (`ask_user`) whose handler raises the same interrupt through
  the existing management API (`raiseApprovalInterrupt` already does this for
  external approvals). This is optional for v1.

### What moves where

| today (#912) | after |
|---|---|
| `ui/src/QuestionCard.tsx` + test | `contrib/ask-user/ui/QuestionCard.tsx` + test |
| `questionsOf()` / `questionAnswers()` | the contrib's renderer (shape check), agent-host size cap only |
| `askUser.ts` (Claude) | generic `blockingToolHook.ts` in core + the contrib's `agent.blockingTools` row |
| `test/e2e/ask-user-question.spec.ts` | stays, but runs with `ask-user` enabled. The fake stack serves no manifest today, so it needs a fixture manifest |
| fake agent `??` directive | becomes a generic "raise kind K with data D" directive |

## Alternatives

- **Keep it in core.** Smallest diff, and it ships today. But each new interaction
  type repeats the five-file edit, and we never find out whether the contrib
  surface can carry real UI. Fine as a stepping stone (#912), not as the end state.
- **Renderer keyed by tool name instead of `kind`.** Simpler for Claude
  (`AskUserQuestion` → card). Lost because the same card should serve requests
  that don't come from a tool call (an MCP tool, a broker-raised request), and
  because tool names collide across providers.
- **Server-rendered forms (JSON schema → generic form).** No contrib code in the
  bundle at all. Lost because the question card has "Other" text replacing the
  options and per-question multi-select, which a generic form either can't express
  or turns into a form DSL we'd then have to maintain.

## Decisions

- **Ship order:** AskUserQuestion ships as a contrib from the start. #912 carries the
  slot, the generic request kind and `contrib/ask-user/` together; the core-only
  version never merged.
- **Placement:** Approvals tab only for now. A `placement` field can be added later
  without breaking any renderer.
- **Goose:** not in v1. Claude only; the `ask_user` MCP tool is a follow-up.

## As built

Where the build differs from the proposal above:

- The data cap is 64 KiB (AskUserQuestion previews can be long); the result cap is 16 KiB.
- `agent.blockingTools` rows also carry `title` (the request heading) and `dismissed`
  (what the model is told on dismiss), so the core hook has no question-specific text.
- The bridge offers the table to the provider as `newSession({ blockingTools })`, which
  the BYO container forwards to its SDK as-is, so BYOC needs no extra wiring.
- The fake agent's `??` directive still raises `ask-user.questions`, rather than a
  generic "kind K, data D" directive; the e2e spec serves the manifest by route.
