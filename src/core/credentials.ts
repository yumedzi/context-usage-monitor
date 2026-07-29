import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';

/**
 * Local Claude Code OAuth token discovery, mirroring how Claude Code itself
 * locates credentials (credentials file, then macOS Keychain) — so the
 * rate-limit gauges can call the same `/api/oauth/usage` endpoint Claude
 * Code's own status line ultimately reflects, without asking the user for
 * a separate API key.
 *
 * This module is the only place that touches the keychain or auth env vars.
 * The token itself must never leave it — not into the tooltip, not into
 * "Copy Diagnostics", not into the cache file.
 */

export type BillingMode = 'subscription' | 'api' | 'unknown';

export interface OAuthToken {
  token: string;
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  source: 'file' | 'keychain';
  expired: boolean;
}

export type ReadTokenResult =
  | { ok: true; tokenInfo: OAuthToken }
  | { ok: false; reason: 'ENV_OVERRIDE'; detail: string }
  | { ok: false; reason: 'NO_TOKEN'; detail: string };

/** Env vars whose presence means Claude Code is on API-key/Bedrock/Vertex/Foundry billing, not a subscription. */
export const AUTH_OVERRIDE_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_CACHE_MS = 2_000;

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function credentialsFilePath(): string {
  return path.join(claudeConfigDir(), '.credentials.json');
}

/** Returns the first auth-override env var name found set, or null if none are. */
export function detectAuthOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  return AUTH_OVERRIDE_ENV.find((name) => !!env[name]) ?? null;
}

/** Reads `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`), if present. */
export function readCredentialsFile(): unknown | null {
  const file = credentialsFilePath();
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed?.claudeAiOauth ?? parsed;
  } catch {
    return null;
  }
}

let keychainCache: { blob: unknown; at: number } | null = null;

/** Reads the OAuth token blob from the macOS Keychain (darwin only). Result is memoized briefly to avoid hammering `security` on rapid re-reads. */
export async function readKeychainToken(fresh = false): Promise<unknown | null> {
  if (process.platform !== 'darwin') return null;
  if (!fresh && keychainCache && Date.now() - keychainCache.at < KEYCHAIN_CACHE_MS) {
    return keychainCache.blob;
  }

  const blob = await new Promise<unknown | null>((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 5_000, encoding: 'utf-8' },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolve(parsed?.claudeAiOauth ?? parsed);
        } catch {
          resolve(null);
        }
      },
    );
  });

  keychainCache = { blob, at: Date.now() };
  return blob;
}

/** Normalizes a raw credentials blob (from either source) into an `OAuthToken`, or null if it lacks an access token. */
export function normalizeToken(blob: unknown, source: 'file' | 'keychain'): OAuthToken | null {
  if (!blob || typeof blob !== 'object') return null;
  const b = blob as Record<string, unknown>;
  const token = typeof b.accessToken === 'string' ? b.accessToken : null;
  if (!token) return null;

  const expiresAt = typeof b.expiresAt === 'number' ? b.expiresAt : null;
  return {
    token,
    expiresAt,
    subscriptionType: typeof b.subscriptionType === 'string' ? b.subscriptionType : null,
    rateLimitTier: typeof b.rateLimitTier === 'string' ? b.rateLimitTier : null,
    source,
    expired: expiresAt != null ? expiresAt <= Date.now() : false,
  };
}

/** Prefers whichever candidate is unexpired; falls back to either if both/neither are. File source wins ties (it's the more explicit/portable one). */
export function chooseToken(fileToken: OAuthToken | null, keychainToken: OAuthToken | null): OAuthToken | null {
  if (fileToken && !fileToken.expired) return fileToken;
  if (keychainToken && !keychainToken.expired) return keychainToken;
  return fileToken || keychainToken || null;
}

export interface ReadTokenOptions {
  fresh?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Full token-discovery pipeline: env override check, then credentials file, then keychain. */
export async function readToken(opts: ReadTokenOptions = {}): Promise<ReadTokenResult> {
  const override = detectAuthOverride(opts.env ?? process.env);
  if (override) {
    return { ok: false, reason: 'ENV_OVERRIDE', detail: override };
  }

  const fileToken = normalizeToken(readCredentialsFile(), 'file');
  const keychainBlob = await readKeychainToken(opts.fresh === true);
  const keychainToken = normalizeToken(keychainBlob, 'keychain');

  const chosen = chooseToken(fileToken, keychainToken);
  if (!chosen) {
    return { ok: false, reason: 'NO_TOKEN', detail: claudeConfigDir() };
  }
  return { ok: true, tokenInfo: chosen };
}
