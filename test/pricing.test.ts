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
  const atISODate = '2026-09-15T00:00:00.000Z'; // Sonnet 5 is a permanent $2/$10 (no intro window)

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

describe('computeTurnCost: model rates', () => {
  const MTOK = 1_000_000;
  const reg = DEFAULT_MODEL_REGISTRY;
  const at = '2026-09-15T00:00:00.000Z';

  it('prices Opus 5.5 cache reads at $0.20/MTok (0.05x), not Opus 5\'s $0.50', () => {
    const r = computeTurnCost(usage({ cacheReadTokens: MTOK }), reg['claude-opus-5-5'], at);
    expect(r.cost).toBeCloseTo(0.2);
    expect(computeTurnCost(usage({ cacheReadTokens: MTOK }), reg['claude-opus-5'], at).cost).toBeCloseTo(0.5);
  });

  it('prices Fable 5.1 cache reads at $0.25/MTok vs Fable 5 at $1.00', () => {
    expect(computeTurnCost(usage({ cacheReadTokens: MTOK }), reg['claude-fable-5-1'], at).cost).toBeCloseTo(0.25);
    expect(computeTurnCost(usage({ cacheReadTokens: MTOK }), reg['claude-fable-5'], at).cost).toBeCloseTo(1);
  });

  it('prices Sonnet 5 at $2/$10 in September 2026 (intro schedule removed)', () => {
    const r = computeTurnCost(usage({ inputTokens: MTOK, outputTokens: MTOK }), reg['claude-sonnet-5'], '2026-09-01T00:00:00.000Z');
    expect(r.cost).toBeCloseTo(12);
  });
});

describe('computeTurnCost: fast mode, data residency, web search', () => {
  const MTOK = 1_000_000;
  const reg = DEFAULT_MODEL_REGISTRY;
  const at = '2026-09-15T00:00:00.000Z';
  const base = { inputTokens: MTOK, outputTokens: MTOK };

  it('fast mode bills Opus 5.5 at 2x ($8/$40)', () => {
    const r = computeTurnCost(usage({ ...base, speed: 'fast' }), reg['claude-opus-5-5'], at);
    expect(r.cost).toBeCloseTo(48);
  });

  it('fast mode bills Opus 5 and 4.8 at $10/$50', () => {
    expect(computeTurnCost(usage({ ...base, speed: 'fast' }), reg['claude-opus-5'], at).cost).toBeCloseTo(60);
    expect(computeTurnCost(usage({ ...base, speed: 'fast' }), reg['claude-opus-4-8'], at).cost).toBeCloseTo(60);
  });

  it('fast multiplier stacks with cache multipliers (cache reads/writes are 2x too)', () => {
    const r = computeTurnCost(usage({ cacheReadTokens: MTOK, cacheWrite1hTokens: MTOK, speed: 'fast' }), reg['claude-opus-5-5'], at);
    expect(r.cost).toBeCloseTo(2 * (0.2 + 8));
  });

  it('prices fast records at standard when the model has no fastMultiplier', () => {
    const std = computeTurnCost(usage(base), reg['claude-sonnet-5'], at).cost;
    expect(computeTurnCost(usage({ ...base, speed: 'fast' }), reg['claude-sonnet-5'], at).cost).toBeCloseTo(std);
  });

  it('speed "standard" is 1x', () => {
    expect(computeTurnCost(usage({ ...base, speed: 'standard' }), reg['claude-opus-5'], at).cost).toBeCloseTo(30);
  });

  it('inference_geo "us" adds 1.1x to all token categories', () => {
    const r = computeTurnCost(usage({ ...base, cacheReadTokens: MTOK, inferenceGeo: 'us' }), reg['claude-sonnet-5'], at);
    expect(r.cost).toBeCloseTo((2 + 10 + 0.2) * 1.1);
  });

  it('"global", "not_available", empty and missing geo are 1x', () => {
    const std = computeTurnCost(usage(base), reg['claude-sonnet-5'], at).cost;
    for (const geo of ['global', 'not_available', '', null, undefined]) {
      expect(computeTurnCost(usage({ ...base, inferenceGeo: geo }), reg['claude-sonnet-5'], at).cost).toBeCloseTo(std);
    }
  });

  it('fast and us multipliers compound', () => {
    const r = computeTurnCost(usage({ ...base, speed: 'fast', inferenceGeo: 'us' }), reg['claude-opus-5-5'], at);
    expect(r.cost).toBeCloseTo(24 * 2 * 1.1);
  });

  it('web searches cost $0.01 each, unaffected by multipliers', () => {
    const r = computeTurnCost(usage({ webSearchRequests: 3, speed: 'fast', inferenceGeo: 'us' }), reg['claude-opus-5-5'], at);
    expect(r.cost).toBeCloseTo(0.03);
    const r2 = computeTurnCost(usage({ inputTokens: MTOK, webSearchRequests: 100 }), reg['claude-sonnet-5'], at);
    expect(r2.cost).toBeCloseTo(2 + 1);
  });

  it('web searches on an unknown model stay unpriced', () => {
    expect(computeTurnCost(usage({ webSearchRequests: 3 }), null, at)).toEqual({ cost: 0, known: false });
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
