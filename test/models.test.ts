import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_REGISTRY, effectivePricing } from '../src/core/models';

describe('effectivePricing (Sonnet 5 intro-pricing window)', () => {
  const entry = DEFAULT_MODEL_REGISTRY['claude-sonnet-5'];

  it('applies intro pricing before the cutoff date', () => {
    const p = effectivePricing(entry, '2026-07-29T10:00:00.000Z');
    expect(p.input).toBeCloseTo(2 / 1_000_000);
    expect(p.output).toBeCloseTo(10 / 1_000_000);
  });

  it('applies intro pricing through the entire final day, inclusive', () => {
    const p = effectivePricing(entry, '2026-08-31T23:59:00.000Z');
    expect(p.input).toBeCloseTo(2 / 1_000_000);
  });

  it('reverts to standard pricing the day after the cutoff', () => {
    const p = effectivePricing(entry, '2026-09-01T00:00:00.000Z');
    expect(p.input).toBeCloseTo(3 / 1_000_000);
    expect(p.output).toBeCloseTo(15 / 1_000_000);
  });

  it('derives cache multipliers from the effective input price, not a fixed base', () => {
    const before = effectivePricing(entry, '2026-07-29T10:00:00.000Z');
    const after = effectivePricing(entry, '2026-09-01T00:00:00.000Z');
    expect(before.cacheWrite1h).toBeCloseTo(before.input * 2);
    expect(after.cacheWrite1h).toBeCloseTo(after.input * 2);
    expect(before.cacheWrite1h).not.toBe(after.cacheWrite1h);
  });

  it('carries no introPrice field on the returned pricing', () => {
    const p = effectivePricing(entry, '2026-07-29T10:00:00.000Z') as Record<string, unknown>;
    expect(p.introPrice).toBeUndefined();
  });
});
