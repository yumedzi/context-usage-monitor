import { ModelPricing, effectivePricing } from './models';

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** cache-creation tokens written at 5-minute TTL */
  cacheWrite5mTokens: number;
  /** cache-creation tokens written at 1-hour TTL */
  cacheWrite1hTokens: number;
}

export interface CostResult {
  cost: number;
  /** true if pricing was resolved and the cost is a real computed value */
  known: boolean;
}

/**
 * Compute the $ cost of a turn's usage against a model's pricing.
 *
 * The upstream extension only scraped a single cache-write rate (the 5m
 * one) and applied it to all cache-creation tokens. Cache writes are
 * actually 1.25x input for a 5-minute TTL but 2x input for a 1-hour TTL —
 * Claude Code's own transcripts carry both `ephemeral_5m_input_tokens` and
 * `ephemeral_1h_input_tokens` under `usage.cache_creation`, so there's no
 * excuse to conflate them.
 */
export function computeTurnCost(
  usage: TurnUsage,
  entry: ModelPricing | null,
  atISODate: string,
): CostResult {
  if (!entry) return { cost: 0, known: false };
  const p = effectivePricing(entry, atISODate);
  const cost =
    usage.inputTokens * p.input +
    usage.cacheWrite5mTokens * p.cacheWrite5m +
    usage.cacheWrite1hTokens * p.cacheWrite1h +
    usage.cacheReadTokens * p.cacheRead +
    usage.outputTokens * p.output;
  return { cost, known: true };
}

/** Tokens counted toward the context-window gauge (everything read/written into the model's context this turn). */
export function contextTokensUsed(usage: TurnUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
}

export function contextFillPercent(usage: TurnUsage, contextWindow: number): number {
  if (contextWindow <= 0) return 0;
  return Math.min(100, Math.round((contextTokensUsed(usage) * 100) / contextWindow));
}

export function cacheHitRatePercent(usage: TurnUsage): number {
  const totalInput = usage.inputTokens + usage.cacheReadTokens;
  if (totalInput <= 0) return 0;
  return Math.round((usage.cacheReadTokens * 100) / totalInput);
}
