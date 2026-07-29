import { describe, expect, it } from 'vitest';
import { resolveModel, isTrackedModel } from '../src/core/resolve';
import { DEFAULT_MODEL_REGISTRY } from '../src/core/models';

describe('resolveModel (RC1: no silent 200K/$? fallback)', () => {
  it('resolves an exact registry key', () => {
    const resolved = resolveModel(DEFAULT_MODEL_REGISTRY, 'claude-sonnet-5');
    expect(resolved?.key).toBe('claude-sonnet-5');
    expect(resolved?.entry.contextWindow).toBe(1_000_000);
  });

  it('resolves a dated snapshot id against its bare alias (longest-prefix match)', () => {
    const resolved = resolveModel(DEFAULT_MODEL_REGISTRY, 'claude-haiku-4-5-20251001');
    expect(resolved?.key).toBe('claude-haiku-4-5');
    expect(resolved?.entry.contextWindow).toBe(200_000);
  });

  it('resolves via trailing -YYYYMMDD suffix stripping when no prefix key matches', () => {
    const registry = { 'claude-sonnet-4-0': DEFAULT_MODEL_REGISTRY['claude-sonnet-4-0'] };
    const resolved = resolveModel(registry, 'claude-sonnet-4-0-20250101');
    expect(resolved?.key).toBe('claude-sonnet-4-0');
  });

  it('returns null (never a guessed default) for an unrecognized model', () => {
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'claude-zzz-9')).toBeNull();
  });

  it('returns null for a scraped marketing-copy key that never matches a real model id', () => {
    // Reproduces the upstream bug: a registry with only the scraped compound key.
    const registry = { 'claude-sonnet-5-through-august-31,-2026': DEFAULT_MODEL_REGISTRY['claude-sonnet-5'] };
    expect(resolveModel(registry, 'claude-sonnet-5')).toBeNull();
  });

  it('returns null for empty/missing model id', () => {
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, '')).toBeNull();
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, undefined)).toBeNull();
  });
});

describe('isTrackedModel', () => {
  it('matches real Claude model ids and excludes <synthetic>', () => {
    expect(isTrackedModel('claude-sonnet-5', '^claude-')).toBe(true);
    expect(isTrackedModel('<synthetic>', '^claude-')).toBe(false);
  });

  it('fails open to the safe default on an invalid user-supplied pattern', () => {
    expect(isTrackedModel('claude-sonnet-5', '(')).toBe(true);
    expect(isTrackedModel('<synthetic>', '(')).toBe(false);
  });
});
