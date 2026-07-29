import { describe, expect, it } from 'vitest';
import { computeTurnCost, contextFillPercent, contextTokensUsed, cacheHitRatePercent, TurnUsage } from '../src/core/pricing';
import { DEFAULT_MODEL_REGISTRY } from '../src/core/models';

function usage(overrides: Partial<TurnUsage>): TurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    ...overrides,
  };
}

describe('computeTurnCost (RC4: 5m vs 1h cache-write pricing)', () => {
  const entry = DEFAULT_MODEL_REGISTRY['claude-sonnet-5'];
  const atISODate = '2026-09-01T00:00:00.000Z'; // past the intro window, standard $3/$15 pricing

  it('prices 1h cache writes at 2x input, distinct from 5m at 1.25x input', () => {
    const at5m = computeTurnCost(usage({ cacheWrite5mTokens: 1000 }), entry, atISODate);
    const at1h = computeTurnCost(usage({ cacheWrite1hTokens: 1000 }), entry, atISODate);
    expect(at1h.known).toBe(true);
    expect(at5m.known).toBe(true);
    expect(at1h.cost).toBeGreaterThan(at5m.cost);
    expect(at5m.cost).toBeCloseTo(1000 * entry.input * 1.25);
    expect(at1h.cost).toBeCloseTo(1000 * entry.input * 2);
  });

  it('returns known:false and cost 0 for an unresolved model (never guesses)', () => {
    const result = computeTurnCost(usage({ inputTokens: 100 }), null, atISODate);
    expect(result).toEqual({ cost: 0, known: false });
  });

  it('sums every token category at its own rate', () => {
    const u = usage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWrite5mTokens: 10, cacheWrite1hTokens: 5 });
    const result = computeTurnCost(u, entry, atISODate);
    const expected = 100 * entry.input + 50 * entry.output + 20 * entry.cacheRead + 10 * entry.cacheWrite5m + 5 * entry.cacheWrite1h;
    expect(result.cost).toBeCloseTo(expected);
  });
});

describe('context / cache helpers', () => {
  it('contextTokensUsed excludes output tokens', () => {
    const u = usage({ inputTokens: 100, outputTokens: 999, cacheReadTokens: 10, cacheWrite5mTokens: 5, cacheWrite1hTokens: 5 });
    expect(contextTokensUsed(u)).toBe(120);
  });

  it('contextFillPercent clamps to 100 and handles a zero context window', () => {
    expect(contextFillPercent(usage({ inputTokens: 5_000_000 }), 1_000_000)).toBe(100);
    expect(contextFillPercent(usage({ inputTokens: 100 }), 0)).toBe(0);
  });

  it('cacheHitRatePercent is 0 with no input at all', () => {
    expect(cacheHitRatePercent(usage({}))).toBe(0);
  });

  it('cacheHitRatePercent reflects cache reads over total input', () => {
    expect(cacheHitRatePercent(usage({ inputTokens: 25, cacheReadTokens: 75 }))).toBe(75);
  });
});
