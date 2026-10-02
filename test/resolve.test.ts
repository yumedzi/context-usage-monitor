import { describe, expect, it } from 'vitest';
import { resolveModel, isTrackedModel, DEFAULT_MODEL_PATTERN } from '../src/core/resolve';
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

  it('resolves claude-opus-5-5 to itself, not to the claude-opus-5 prefix', () => {
    const resolved = resolveModel(DEFAULT_MODEL_REGISTRY, 'claude-opus-5-5');
    expect(resolved?.key).toBe('claude-opus-5-5');
    expect(resolved?.entry.cacheRead).toBeCloseTo(0.2e-6);
  });

  it('resolves claude-fable-5-1 and claude-sonnet-5-5 exactly', () => {
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'claude-fable-5-1')?.key).toBe('claude-fable-5-1');
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'claude-sonnet-5-5')?.key).toBe('claude-sonnet-5-5');
  });

  it('returns null for a not-yet-registered sibling like claude-opus-5-9 (no prefix guessing)', () => {
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'claude-opus-5-9')).toBeNull();
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'claude-sonnet-5-9')).toBeNull();
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'claude-opus-5-5-fast')).toBeNull();
  });

  it('resolves dated, @date and [1m] variants of a registry key', () => {
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'claude-opus-5-5-20260301')?.key).toBe('claude-opus-5-5');
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'claude-sonnet-4-5@20250929')?.key).toBe('claude-sonnet-4-5');
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'claude-sonnet-4-5[1m]')?.key).toBe('claude-sonnet-4-5');
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'claude-opus-5-5-v2')?.key).toBe('claude-opus-5-5');
  });

  it('resolves Bedrock-style ids after stripping the provider prefix', () => {
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'anthropic.claude-sonnet-4-5-20250929-v1:0')?.key).toBe('claude-sonnet-4-5');
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'us.anthropic.claude-haiku-4-5-20251001-v1:0')?.key).toBe('claude-haiku-4-5');
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'eu.anthropic.claude-opus-5-5')?.key).toBe('claude-opus-5-5');
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'global.anthropic.claude-sonnet-5-v1:0')?.key).toBe('claude-sonnet-5');
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'apac.anthropic.claude-opus-5-9-v1:0')).toBeNull();
  });

  it('returns null for aliases like "sonnet"', () => {
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'sonnet')).toBeNull();
    expect(resolveModel(DEFAULT_MODEL_REGISTRY, 'opus')).toBeNull();
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

  it('default pattern accepts Bedrock-style ids but still rejects aliases and non-Claude strings', () => {
    for (const id of ['claude-opus-5-5', 'anthropic.claude-sonnet-4-5-v1:0', 'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'global.anthropic.claude-sonnet-5']) {
      expect(isTrackedModel(id, DEFAULT_MODEL_PATTERN)).toBe(true);
    }
    for (const id of ['sonnet', 'opus', 'haiku', '<synthetic>', 'gpt-4o', 'foo.claude-x']) {
      expect(isTrackedModel(id, DEFAULT_MODEL_PATTERN)).toBe(false);
    }
  });

  it('fails open to the safe default on an invalid user-supplied pattern', () => {
    expect(isTrackedModel('claude-sonnet-5', '(')).toBe(true);
    expect(isTrackedModel('<synthetic>', '(')).toBe(false);
  });
});
