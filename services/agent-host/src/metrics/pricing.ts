/**
 * Cost derivation: token usage times a per-model price table, supplied by the
 * deployer (modules/platform.nix `observability.pricing`) in USD per million tokens
 * and split by token kind so cached reads/writes can be priced differently.
 */

/** Per-model prices in USD per million tokens; missing fields default to 0. */
export interface ModelPrice {
  /** USD per 1M fresh input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
  /** USD per 1M cached-read input tokens. */
  cachedReadPerMillion?: number;
  /** USD per 1M cache-write tokens. */
  cachedWritePerMillion?: number;
}

/** The full price table, keyed by the conversation's resolved model id. */
export type PriceTable = Record<string, ModelPrice>;

/** A single run's token usage; fields are optional so a partial goose schema still yields a best-effort cost. */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  /** Thought/reasoning tokens, if the provider reports them separately. */
  thoughtTokens?: number;
  /** Total, if the source gives a total but not the split. */
  totalTokens?: number;
}

/** The derived cost breakdown for a run, USD. */
export interface CostBreakdown {
  model: string;
  inputCost: number;
  outputCost: number;
  cachedReadCost: number;
  cachedWriteCost: number;
  totalCost: number;
  /** False when the model was not in the price table, so a caller can skip the cost metric rather than report a misleading 0. */
  priced: boolean;
}

/** Parse a price table from raw JSON, throwing on malformed JSON and defaulting missing per-model fields to 0. */
export function parsePriceTable(json: string): PriceTable {
  const raw = JSON.parse(json) as Record<string, Partial<ModelPrice>>;
  const out: PriceTable = {};
  for (const [model, p] of Object.entries(raw ?? {})) {
    out[model] = {
      inputPerMillion: Number(p.inputPerMillion ?? 0),
      outputPerMillion: Number(p.outputPerMillion ?? 0),
      cachedReadPerMillion: p.cachedReadPerMillion != null ? Number(p.cachedReadPerMillion) : undefined,
      cachedWritePerMillion: p.cachedWritePerMillion != null ? Number(p.cachedWritePerMillion) : undefined,
    };
  }
  return out;
}

/** Compute the USD cost of a run, or a zeroed breakdown with `priced: false` when `model` is not in the table. */
export function computeCost(model: string, usage: TokenUsage, prices: PriceTable): CostBreakdown {
  const price = prices[model];
  const perM = (tokens: number | undefined, rate: number | undefined): number =>
    ((tokens ?? 0) * (rate ?? 0)) / 1_000_000;

  if (!price) {
    return {
      model,
      inputCost: 0,
      outputCost: 0,
      cachedReadCost: 0,
      cachedWriteCost: 0,
      totalCost: 0,
      priced: false,
    };
  }

  const inputCost = perM(usage.inputTokens, price.inputPerMillion);
  const outputCost = perM(usage.outputTokens, price.outputPerMillion);
  const cachedReadCost = perM(usage.cachedReadTokens, price.cachedReadPerMillion);
  const cachedWriteCost = perM(usage.cachedWriteTokens, price.cachedWritePerMillion);
  return {
    model,
    inputCost,
    outputCost,
    cachedReadCost,
    cachedWriteCost,
    totalCost: inputCost + outputCost + cachedReadCost + cachedWriteCost,
    priced: true,
  };
}
