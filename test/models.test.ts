import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_REGISTRY, ModelPricing, applyPricingOverride, effectivePricing } from '../src/core/models';

describe('registry invariants', () => {
  for (const [id, p] of Object.entries(DEFAULT_MODEL_REGISTRY)) {
    it(`${id}: cache rates are consistent with input price`, () => {
      expect(p.cacheRead).toBeLessThanOrEqual(p.input);
      expect(p.cacheRead).toBeGreaterThan(0);
      expect(p.cacheWrite5m).toBeCloseTo(p.input * 1.25, 12);
      expect(p.cacheWrite1h).toBeCloseTo(p.input * 2, 12);
      expect(p.output).toBeGreaterThan(p.input);
      expect(p.contextWindow).toBeGreaterThan(0);
    });
  }

  it('no built-in model uses introPrice (Sonnet 5 is a permanent $2/$10)', () => {
    for (const p of Object.values(DEFAULT_MODEL_REGISTRY)) expect(p.introPrice).toBeUndefined();
  });

  it('has the verified per-MTok rates for the newest models', () => {
    const perM = (id: string) => {
      const p = DEFAULT_MODEL_REGISTRY[id];
      return [p.input, p.output, p.cacheRead, p.cacheWrite5m, p.cacheWrite1h].map((v) => +(v * 1e6).toFixed(6));
    };
    expect(perM('claude-fable-5-1')).toEqual([10, 50, 0.25, 12.5, 20]);
    expect(perM('claude-mythos-5-1')).toEqual([10, 50, 0.25, 12.5, 20]);
    expect(perM('claude-fable-5')).toEqual([10, 50, 1, 12.5, 20]);
    expect(perM('claude-opus-5-5')).toEqual([4, 20, 0.2, 5, 8]);
    expect(perM('claude-opus-5')).toEqual([5, 25, 0.5, 6.25, 10]);
    expect(perM('claude-opus-4-1')).toEqual([15, 75, 1.5, 18.75, 30]);
    expect(perM('claude-sonnet-5-5')).toEqual([2, 10, 0.2, 2.5, 4]);
    expect(perM('claude-sonnet-5')).toEqual([2, 10, 0.2, 2.5, 4]);
    expect(perM('claude-3-5-haiku-20241022')).toEqual([0.8, 4, 0.08, 1, 1.6]);
    expect(DEFAULT_MODEL_REGISTRY['claude-opus-4-1'].contextWindow).toBe(200_000);
  });

  it('only Opus 5.5 / 5 / 4.8 have a fast mode, at 2x', () => {
    const fast = Object.entries(DEFAULT_MODEL_REGISTRY)
      .filter(([, p]) => p.fastMultiplier !== undefined)
      .map(([id, p]) => [id, p.fastMultiplier]);
    expect(fast.sort()).toEqual([
      ['claude-opus-4-8', 2],
      ['claude-opus-5', 2],
      ['claude-opus-5-5', 2],
    ]);
  });
});

describe('effectivePricing (introPrice mechanism, unused by built-ins)', () => {
  const entry: ModelPricing = {
    input: 3e-6,
    output: 15e-6,
    cacheRead: 0.3e-6,
    cacheWrite5m: 3.75e-6,
    cacheWrite1h: 6e-6,
    contextWindow: 1_000_000,
    introPrice: { input: 2e-6, output: 10e-6, cacheRead: 0.2e-6, cacheWrite5m: 2.5e-6, cacheWrite1h: 4e-6, until: '2026-08-31' },
  };

  it('applies intro pricing through the entire final day, inclusive', () => {
    expect(effectivePricing(entry, '2026-08-31T23:59:00.000Z').input).toBeCloseTo(2e-6);
  });

  it('reverts to standard pricing the day after the cutoff', () => {
    const p = effectivePricing(entry, '2026-09-01T00:00:00.000Z');
    expect(p.input).toBeCloseTo(3e-6);
    expect(p.output).toBeCloseTo(15e-6);
  });

  it('carries no introPrice field on the returned pricing', () => {
    const p = effectivePricing(entry, '2026-07-29T10:00:00.000Z') as Record<string, unknown>;
    expect(p.introPrice).toBeUndefined();
  });

  it('keeps fastMultiplier on the effective pricing', () => {
    const p = effectivePricing({ ...DEFAULT_MODEL_REGISTRY['claude-opus-5-5'] }, '2026-09-01T00:00:00.000Z');
    expect(p.fastMultiplier).toBe(2);
  });
});

describe('applyPricingOverride', () => {
  const base = DEFAULT_MODEL_REGISTRY['claude-opus-5-5'];

  it('overriding only contextWindow leaves pricing untouched', () => {
    const r = applyPricingOverride(base, { contextWindow: 123 });
    expect(r).toEqual({ ...base, contextWindow: 123 });
  });

  it('accepts per-MTok fields and an explicit cacheReadPerMTok', () => {
    const r = applyPricingOverride(undefined, { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.15 });
    expect(r.input).toBeCloseTo(3e-6);
    expect(r.output).toBeCloseTo(15e-6);
    expect(r.cacheRead).toBeCloseTo(0.15e-6);
    expect(r.cacheWrite5m).toBeCloseTo(3.75e-6);
    expect(r.cacheWrite1h).toBeCloseTo(6e-6);
  });

  it('re-derives cache rates from an overridden input, keeping the base cache-read ratio', () => {
    const r = applyPricingOverride(base, { inputPerMTok: 8 });
    expect(r.cacheRead).toBeCloseTo(8e-6 * 0.05);
    expect(r.cacheWrite1h).toBeCloseTo(16e-6);
  });

  it('a brand-new model with only input/output does not get free cache reads', () => {
    const r = applyPricingOverride(undefined, { input: 3e-6, output: 15e-6 });
    expect(r.cacheRead).toBeCloseTo(0.3e-6);
    expect(r.contextWindow).toBe(200_000);
  });

  it('explicit per-token cacheRead wins over per-MTok and derivation', () => {
    const r = applyPricingOverride(base, { input: 8e-6, cacheRead: 1e-6, cacheReadPerMTok: 9 });
    expect(r.cacheRead).toBeCloseTo(1e-6);
  });
});
