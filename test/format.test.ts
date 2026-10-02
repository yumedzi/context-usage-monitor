import { describe, expect, it } from 'vitest';
import { formatTokens, formatCost, formatCostPartial, monthlyBreakdownLines } from '../src/core/format';

describe('formatTokens', () => {
  it('uses K/M suffixes and passes small numbers through', () => {
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(52_500)).toBe('52.5K');
    expect(formatTokens(1_000_000)).toBe('1.0M');
  });
});

describe('formatCost', () => {
  it('renders $? when pricing is unknown (RC1 explicit-unknown UI)', () => {
    expect(formatCost(0, false, '$')).toBe('$?');
  });

  it('uses tiered precision by magnitude', () => {
    expect(formatCost(2.5, true, '$')).toBe('$2.50');
    expect(formatCost(0.0123, true, '$')).toBe('$0.012');
    expect(formatCost(0.00004, true, '$')).toBe('$0.0000');
  });

  it('honors a configurable currency symbol', () => {
    expect(formatCost(1.5, true, '€')).toBe('€1.50');
  });
});

describe('formatCostPartial / monthlyBreakdownLines', () => {
  it('prefixes a lower-bound figure with "≥ "', () => {
    expect(formatCostPartial(12.5, true, true, '$')).toBe('≥ $12.50');
    expect(formatCostPartial(12.5, true, false, '$')).toBe('$12.50');
    expect(formatCostPartial(0, false, true, '$')).toBe('$?');
  });

  it('lists priced models by cost then unpriced ids', () => {
    const lines = monthlyBreakdownLines(
      {
        totalCostUSD: 15,
        perModel: { 'claude-a': 5, 'claude-b': 10 },
        unknownModels: { 'claude-x': { records: 3, tokens: 2500 } },
      },
      '$',
    );
    expect(lines[0]).toBe('- claude-b: $10.00');
    expect(lines[1]).toBe('- claude-a: $5.00');
    expect(lines[2]).toContain('claude-x: UNPRICED');
    expect(lines[2]).toContain('3 turns');
  });
});
