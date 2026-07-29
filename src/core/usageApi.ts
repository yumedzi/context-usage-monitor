import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { claudeConfigDir, readToken, detectAuthOverride, OAuthToken } from './credentials';
import { parseUsageResponse, classifyPlan, RateLimitSnapshot } from './rateLimits';

/**
 * Fetches subscription rate-limit data from Anthropic's OAuth usage API and
 * caches it on disk so every open VS Code window shares one network call per
 * refresh interval, rather than each hitting the API independently and
 * risking a 429. Same endpoints and headers as verified manually against the
 * live API on 2026-07-29.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const REQUEST_HEADERS = {
  'anthropic-beta': 'oauth-2025-04-20',
  'anthropic-version': '2023-06-01',
  Accept: 'application/json',
  'User-Agent': 'context-usage-monitor (oauth-usage)',
};
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

const CACHE_DIR = path.join(claudeConfigDir(), '.context-usage-monitor');
const CACHE_FILE = path.join(CACHE_DIR, 'rate-cache.json');

interface CacheFile {
  snapshot: RateLimitSnapshot;
  fetchedAt: number;
  failCount: number;
  lastErrorReason: string | null;
  tokenSource: 'file' | 'keychain' | null;
}

export interface RateLimitCacheMeta {
  lastErrorReason: string | null;
  tokenSource: 'file' | 'keychain' | null;
}

async function readCacheFile(): Promise<CacheFile | null> {
  try {
    const raw = await fsp.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }
}

async function writeCacheFile(data: CacheFile): Promise<void> {
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    const tmp = `${CACHE_FILE}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fsp.rename(tmp, CACHE_FILE);
  } catch {
    // Best-effort cache; a failure to persist doesn't affect the snapshot we return.
  }
}

/** For "Copy Diagnostics" — never exposes the token itself. */
export async function readCacheMeta(): Promise<RateLimitCacheMeta | null> {
  const cache = await readCacheFile();
  if (!cache) return null;
  return { lastErrorReason: cache.lastErrorReason, tokenSource: cache.tokenSource };
}

class RateLimitFetchError extends Error {}

async function doGet(url: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...REQUEST_HEADERS, Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new RateLimitFetchError('TOKEN_REJECTED');
    }
    if (!res.ok) {
      throw new RateLimitFetchError(`API_ERROR_${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof RateLimitFetchError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new RateLimitFetchError('FETCH_TIMEOUT');
    }
    throw new RateLimitFetchError(err instanceof Error ? err.message : 'NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBoth(token: string): Promise<{ usage: unknown; profile: unknown | null }> {
  const [usageResult, profileResult] = await Promise.allSettled([doGet(USAGE_URL, token), doGet(PROFILE_URL, token)]);
  if (usageResult.status === 'rejected') throw usageResult.reason;
  return { usage: usageResult.value, profile: profileResult.status === 'fulfilled' ? profileResult.value : null };
}

async function fetchWithRetry(
  tokenInfo: OAuthToken,
  env: NodeJS.ProcessEnv,
): Promise<{ usage: unknown; profile: unknown | null; tokenSource: 'file' | 'keychain' }> {
  try {
    const result = await fetchBoth(tokenInfo.token);
    return { ...result, tokenSource: tokenInfo.source };
  } catch (err) {
    if (!(err instanceof RateLimitFetchError) || err.message !== 'TOKEN_REJECTED') throw err;

    const fresh = await readToken({ fresh: true, env });
    if (fresh.ok && fresh.tokenInfo.token !== tokenInfo.token) {
      const result = await fetchBoth(fresh.tokenInfo.token);
      return { ...result, tokenSource: fresh.tokenInfo.source };
    }
    throw err;
  }
}

function emptySnapshot(billingMode: RateLimitSnapshot['billingMode']): RateLimitSnapshot {
  return {
    fiveHour: null,
    sevenDay: null,
    sevenDayOpus: null,
    sevenDaySonnet: null,
    billingMode,
    planLabel: null,
    fetchedAt: Date.now(),
    stale: false,
  };
}

async function handleFailure(cache: CacheFile | null, reason: string): Promise<RateLimitSnapshot> {
  const nextFailCount = (cache?.failCount ?? 0) + 1;

  if (cache) {
    await writeCacheFile({ ...cache, failCount: nextFailCount, lastErrorReason: reason });
    return { ...cache.snapshot, stale: true };
  }

  const snapshot = emptySnapshot('unknown');
  await writeCacheFile({ snapshot, fetchedAt: snapshot.fetchedAt, failCount: nextFailCount, lastErrorReason: reason, tokenSource: null });
  return snapshot;
}

export interface FetchRateLimitsOptions {
  /** Base refresh interval in ms; doubles per consecutive failure up to a 15-minute ceiling. */
  ttlMs: number;
  /** Bypass the cache TTL and force a network attempt (used by the manual refresh command). */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
}

export async function fetchRateLimits(opts: FetchRateLimitsOptions): Promise<RateLimitSnapshot> {
  const env = opts.env ?? process.env;

  // Checked before the cache TTL gate below, deliberately: it's a cheap,
  // synchronous, in-process check (no fs/network), and env vars can differ
  // across VS Code windows/terminals sharing this machine's cache file. If
  // we let the TTL gate answer first, a cached 'api'-mode snapshot written
  // by one window's overridden environment would incorrectly serve in
  // another window that has no override at all.
  const authOverride = detectAuthOverride(env);
  if (authOverride) {
    const snapshot = emptySnapshot('api');
    await writeCacheFile({ snapshot, fetchedAt: snapshot.fetchedAt, failCount: 0, lastErrorReason: null, tokenSource: null });
    return snapshot;
  }

  const cache = await readCacheFile();
  const failCount = cache?.failCount ?? 0;
  const effectiveTtl = Math.min(opts.ttlMs * 2 ** failCount, MAX_BACKOFF_MS);

  // A cached 'api'-mode snapshot with no override now means the override
  // was present on a prior call (this session or another window) and has
  // since gone away — never trust its TTL, always re-fetch for real.
  const cacheIsUsable = cache && cache.snapshot.billingMode !== 'api';

  if (!opts.force && cacheIsUsable && Date.now() - cache.fetchedAt < effectiveTtl) {
    return cache.snapshot;
  }

  const tokenResult = await readToken({ env });
  if (!tokenResult.ok) {
    return handleFailure(cache, tokenResult.reason);
  }

  try {
    const { usage, profile, tokenSource } = await fetchWithRetry(tokenResult.tokenInfo, env);
    const windows = parseUsageResponse(usage);
    const { billingMode, planLabel } = classifyPlan(profile, tokenResult.tokenInfo.subscriptionType, null);
    const snapshot: RateLimitSnapshot = { ...windows, billingMode, planLabel, fetchedAt: Date.now(), stale: false };
    await writeCacheFile({ snapshot, fetchedAt: snapshot.fetchedAt, failCount: 0, lastErrorReason: null, tokenSource });
    return snapshot;
  } catch (err) {
    return handleFailure(cache, err instanceof Error ? err.message : 'UNKNOWN_ERROR');
  }
}

export const RATE_CACHE_FILE = CACHE_FILE;
