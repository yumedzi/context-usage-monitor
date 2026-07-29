import { describe, expect, it } from 'vitest';
import { detectAuthOverride, normalizeToken, chooseToken, AUTH_OVERRIDE_ENV } from '../src/core/credentials';

describe('detectAuthOverride', () => {
  it('returns null when none of the override env vars are set', () => {
    expect(detectAuthOverride({})).toBeNull();
  });

  it.each(AUTH_OVERRIDE_ENV)('detects %s when set', (name) => {
    expect(detectAuthOverride({ [name]: 'x' })).toBe(name);
  });

  it('returns the first match when multiple are set', () => {
    expect(detectAuthOverride({ ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('ANTHROPIC_API_KEY');
  });
});

describe('normalizeToken', () => {
  it('returns null for a blob with no accessToken', () => {
    expect(normalizeToken({}, 'file')).toBeNull();
    expect(normalizeToken(null, 'keychain')).toBeNull();
  });

  it('normalizes a valid blob, marking it unexpired when expiresAt is in the future', () => {
    const future = Date.now() + 60_000;
    const token = normalizeToken(
      { accessToken: 'tok', expiresAt: future, scopes: ['a'], subscriptionType: 'pro', rateLimitTier: 'default' },
      'keychain',
    );
    expect(token).toEqual({
      token: 'tok',
      expiresAt: future,
      subscriptionType: 'pro',
      rateLimitTier: 'default',
      source: 'keychain',
      expired: false,
    });
  });

  it('marks a token expired when expiresAt is in the past', () => {
    const past = Date.now() - 1000;
    const token = normalizeToken({ accessToken: 'tok', expiresAt: past }, 'file');
    expect(token?.expired).toBe(true);
  });

  it('treats a missing expiresAt as never-expired', () => {
    const token = normalizeToken({ accessToken: 'tok' }, 'file');
    expect(token?.expired).toBe(false);
    expect(token?.expiresAt).toBeNull();
  });
});

describe('chooseToken', () => {
  const unexpired = (source: 'file' | 'keychain') => ({
    token: source,
    expiresAt: null,
    subscriptionType: null,
    rateLimitTier: null,
    source,
    expired: false,
  });
  const expired = (source: 'file' | 'keychain') => ({ ...unexpired(source), expired: true });

  it('prefers the file token when both are unexpired', () => {
    expect(chooseToken(unexpired('file'), unexpired('keychain'))?.source).toBe('file');
  });

  it('prefers whichever is unexpired', () => {
    expect(chooseToken(expired('file'), unexpired('keychain'))?.source).toBe('keychain');
    expect(chooseToken(unexpired('file'), expired('keychain'))?.source).toBe('file');
  });

  it('falls back to either if both are expired', () => {
    expect(chooseToken(expired('file'), expired('keychain'))?.source).toBe('file');
  });

  it('returns null when both are absent', () => {
    expect(chooseToken(null, null)).toBeNull();
  });

  it('returns whichever single candidate is present', () => {
    expect(chooseToken(null, unexpired('keychain'))?.source).toBe('keychain');
    expect(chooseToken(unexpired('file'), null)?.source).toBe('file');
  });
});
