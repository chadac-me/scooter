# Models

The model catalog is **provider-first**: model ids are provider-specific namespaces (Bedrock
ids like `us.anthropic.claude-sonnet-4-6` mean nothing to a subscription-backed provider, and
vice versa), so each provider group lists what it offers and marks its own default.

```nix
scooter.agent.availableModels = {
  goose = {
    "us.anthropic.claude-sonnet-4-6" = { default = true; hint = "Fast + cheap."; };
    "us.anthropic.claude-opus-4-8"  = { hint = "Slow + powerful."; };
  };
  byoc."claude-sonnet-4-5" = { default = true; hint = "The user's own subscription."; };
};
```

- A run only ever receives a model **its provider can serve** — the conversation's choice when
  that provider offers it, else that provider's default. A Bedrock id never reaches a
  bring-your-own container.
- The **agent picks its own model** via the `list_models` / `switch_model` tools, steered by
  your `hint`s; the UI and management API can override per conversation.
- Providers: `goose` (Bedrock), `claude-code` (in-cluster subscription SDK), `byoc` (the
  user's own container).

## Context windows

goose looks each model id up in its built-in model table to learn the context window. An id
it does not know yet — typically a Bedrock inference profile newer than the goose build —
falls back to **128,000 tokens**. That makes auto-compaction fire far too early, and the agent,
which is shown its usage against that window, starts declining work it believes will not fit.

Declare the window next to the model:

```nix
scooter.agent.availableModels.goose = {
  "us.anthropic.claude-opus-5-5" = { default = true; contextLimit = 1000000; };
  "us.anthropic.claude-haiku-4-5" = { contextLimit = 200000; };
};
```

Each conversation's goose receives `GOOSE_CONTEXT_LIMIT` for the model it runs on, and a
`switch_model` relaunches goose with the new model's limit. Precedence: a global
`GOOSE_CONTEXT_LIMIT` (via `scooter.agent.env`) > the model's `contextLimit` > goose's own
table.

!!! note "Changing the default model"
    The default comes from the catalog's `default = true` entry, not from `GOOSE_MODEL`:
    with a catalog configured, setting `GOOSE_MODEL` on the Deployment alone changes nothing.

## Extra goose environment

goose gets only an allowlist of the agent-host's environment (provider, model, AWS
credentials, `GOOSE_CONTEXT_LIMIT`, `OLLAMA_HOST`, …). To pass more:

```nix
scooter.agent.env = { GOOSE_AUTO_COMPACT_THRESHOLD = "0.7"; GOOSE_MAX_TURNS = "200"; };
# Vars that reach the agent-host some other way (e.g. a patched-in secretKeyRef):
scooter.agent.envPassthrough = [ "GOOSE_TOOLSHIM" ];
```

Both are rendered as `AGENT_ENV_PASSTHROUGH`, a comma-separated list of names the agent-host
forwards on top of the allowlist.
