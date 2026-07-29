import { describe, expect, it } from 'vitest';
import { formatTokens, formatCost } from '../src/core/format';

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
