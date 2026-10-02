import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { parseUsageLine, TranscriptFilterOptions } from './transcript';
import { resolveModel } from './resolve';
import { computeTurnCost } from './pricing';
import { ModelPricing } from './models';

/**
 * Bump whenever the meaning of cached per-record costs changes (pricing
 * rules, record shape). A cache with a different version is discarded and
 * fully rescanned. v1 (implicit, no field) held costs priced with the old,
 * wrong registry; v2 adds per-model/unknown tracking and refcounts.
 */
export const CACHE_VERSION = 2;

export type BillingTimeZone = 'local' | 'utc';

export interface FileCacheEntry {
  size: number;
  mtimeMs: number;
  /** bytes from the start of the file already parsed (always ends on a line boundary) */
  processedBytes: number;
  /** dedupe keys this file has contributed (one entry per occurrence), so a shrink/rewrite/delete can be cleanly undone */
  keys: string[];
}

export interface CachedRecord {
  /** $ cost (0 for unknown models) */
  cost: number;
  /** index into MonthlyUsageCache.models: resolved registry key, or the raw id when unknown */
  model: number;
  /** total tokens of all categories */
  tokens: number;
  /** true if the model id did not resolve against the registry (excluded from the total) */
  unknown?: true;
}

export interface MonthlyUsageCache {
  cacheVersion: number;
  /** ISO date (YYYY-MM-DD) the current billing period started on */
  billingPeriodStart: string;
  /** hash of the inputs that affect cached costs (registry, model filter, time zone); mismatch => rescan */
  fingerprint: string;
  files: Record<string, FileCacheEntry>;
  /** dedupe key -> cached record */
  records: Record<string, CachedRecord>;
  /** dedupe key -> number of file occurrences referencing it (record is dropped when it reaches 0) */
  refs: Record<string, number>;
  /** model-id intern table for CachedRecord.model */
  models: string[];
}

export function emptyCache(periodStart: string, fingerprint = ''): MonthlyUsageCache {
  return {
    cacheVersion: CACHE_VERSION,
    billingPeriodStart: periodStart,
    fingerprint,
    files: {},
    records: {},
    refs: {},
    models: [],
  };
}

/** True if a persisted cache object was written by this cache-format version. */
export function isCurrentCache(cache: unknown): cache is MonthlyUsageCache {
  return !!cache && typeof cache === 'object' && (cache as MonthlyUsageCache).cacheVersion === CACHE_VERSION;
}

/** Compute the ISO date (YYYY-MM-DD) the current billing period starts on, given an anchor day-of-month (1-28). */
export function billingPeriodStart(now: Date, anchorDay: number, tz: BillingTimeZone = 'local'): string {
  const day = Math.min(Math.max(Math.floor(anchorDay), 1), 28);
  const utc = tz === 'utc';
  const y = utc ? now.getUTCFullYear() : now.getFullYear();
  const m = utc ? now.getUTCMonth() : now.getMonth();
  const d = utc ? now.getUTCDate() : now.getDate();
  const startMonth = d >= day ? m : m - 1;
  // Normalise through Date so month -1 rolls into the previous year.
  const normalised = new Date(Date.UTC(y, startMonth, day));
  const yy = normalised.getUTCFullYear();
  const mm = String(normalised.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(normalised.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function toISODateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function withinPeriod(
  timestamp: string | null,
  periodStartISODate: string,
  now: Date,
  tz: BillingTimeZone = 'local',
): boolean {
  if (!timestamp) return false;
  const t = new Date(timestamp).getTime();
  if (Number.isNaN(t)) return false;
  const start = new Date(`${periodStartISODate}T00:00:00${tz === 'utc' ? 'Z' : ''}`).getTime();
  return t >= start && t <= now.getTime();
}

async function findJsonlFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(full);
      }
    }
  }
  await walk(rootDir);
  return results;
}

export interface MonthlyUsageOptions extends TranscriptFilterOptions {
  registry: Record<string, ModelPricing>;
  billingCycleStartDay: number;
  /** which clock the billing period boundary is measured on (default "local") */
  billingCycleTimeZone?: BillingTimeZone;
  now?: Date;
}

export interface UnknownModelStats {
  /** distinct deduped records */
  records: number;
  tokens: number;
}

export interface MonthlyUsageResult {
  /** total over models the registry could price; a lower bound when `unknownModels` is non-empty */
  totalCostUSD: number;
  /** $ cost per resolved registry key */
  perModel: Record<string, number>;
  /** model ids that passed the model filter but did not resolve — excluded from the total */
  unknownModels: Record<string, UnknownModelStats>;
  /** true when unknownModels is non-empty, i.e. totalCostUSD is "at least" the real figure */
  partial: boolean;
  cache: MonthlyUsageCache;
  filesScanned: number;
  /** distinct newly counted records that were priced (unknown-model records are excluded) */
  recordsCounted: number;
}

function fingerprintOf(opts: MonthlyUsageOptions): string {
  return createHash('sha1')
    .update(JSON.stringify([opts.registry, opts.modelPattern, opts.billingCycleTimeZone ?? 'local']))
    .digest('hex')
    .slice(0, 16);
}

function internModel(cache: MonthlyUsageCache, id: string): number {
  let idx = cache.models.indexOf(id);
  if (idx < 0) {
    idx = cache.models.length;
    cache.models.push(id);
  }
  return idx;
}

function releaseKeys(cache: MonthlyUsageCache, keys: string[]): void {
  for (const key of keys) {
    const left = (cache.refs[key] ?? 0) - 1;
    if (left <= 0) {
      delete cache.refs[key];
      delete cache.records[key];
    } else {
      cache.refs[key] = left;
    }
  }
}

/**
 * Compute (and incrementally update) the total $ cost of Claude Code usage
 * across every project directory, for the current billing period.
 *
 * Reuses `previousCache` and reads only newly appended bytes on repeat
 * calls; a file that shrank or was rewritten (mtime moved backwards, or
 * size dropped) is detected and fully rescanned. A cache from another
 * cache-format version, billing period, or pricing/filter configuration is
 * discarded. Measured cold-scan cost on a real ~270MB / 220-file
 * `~/.claude/projects` tree: well under a second — the incremental path is a
 * steady-state optimization, not a correctness requirement.
 *
 * Dedupe: records sharing `messageId::requestId` count once, even across
 * files. Each file occurrence holds a reference, so deleting the file that
 * first contributed a shared record keeps it alive while another file still
 * has it.
 */
export async function computeMonthlyUsage(
  projectsDir: string,
  previousCache: MonthlyUsageCache | undefined,
  opts: MonthlyUsageOptions,
): Promise<MonthlyUsageResult> {
  const now = opts.now ?? new Date();
  const tz = opts.billingCycleTimeZone ?? 'local';
  const periodStart = billingPeriodStart(now, opts.billingCycleStartDay, tz);
  const fingerprint = fingerprintOf(opts);
  const cache: MonthlyUsageCache =
    previousCache &&
    isCurrentCache(previousCache) &&
    previousCache.billingPeriodStart === periodStart &&
    previousCache.fingerprint === fingerprint
      ? previousCache
      : emptyCache(periodStart, fingerprint);

  const files = await findJsonlFiles(projectsDir);
  const liveFiles = new Set(files);
  let recordsCounted = 0;

  for (const file of files) {
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      continue;
    }

    let entry = cache.files[file];
    const shrunkOrRewritten = !!entry && (stat.size < entry.size || stat.mtimeMs < entry.mtimeMs);

    if (!entry || shrunkOrRewritten) {
      if (entry) releaseKeys(cache, entry.keys);
      entry = { size: 0, mtimeMs: 0, processedBytes: 0, keys: [] };
      cache.files[file] = entry;
    }

    if (stat.size === entry.processedBytes && stat.mtimeMs === entry.mtimeMs) {
      continue; // unchanged since last scan
    }

    const readLength = stat.size - entry.processedBytes;
    if (readLength <= 0) {
      entry.size = stat.size;
      entry.mtimeMs = stat.mtimeMs;
      continue;
    }

    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(readLength);
      await fh.read(buf, 0, readLength, entry.processedBytes);
      const text = buf.toString('utf8');

      const lastNewline = text.lastIndexOf('\n');
      const usableText = lastNewline >= 0 ? text.slice(0, lastNewline) : '';
      const consumedBytes = lastNewline >= 0 ? Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8') : 0;

      if (usableText) {
        let lineOffset = entry.processedBytes;
        for (const line of usableText.split('\n')) {
          const thisLineOffset = lineOffset;
          lineOffset += Buffer.byteLength(line, 'utf8') + 1;

          const record = parseUsageLine(line, opts);
          if (!record) continue;
          if (!withinPeriod(record.timestamp, periodStart, now, tz)) continue;

          const resolved = resolveModel(opts.registry, record.model);
          const { cost, known } = computeTurnCost(
            record.usage,
            resolved?.entry ?? null,
            record.timestamp ?? toISODateLocal(now),
          );

          // A record with neither id gets a key unique to its file position, so it is
          // still counted (never merged into an unrelated record) and stays stable
          // across scans/restarts.
          const key =
            record.messageId || record.requestId
              ? `${record.messageId ?? ''}::${record.requestId ?? ''}`
              : `__nokey__${file}:${thisLineOffset}`;

          const u = record.usage;
          const cached: CachedRecord = {
            cost: known ? cost : 0,
            model: internModel(cache, resolved?.key ?? record.model),
            tokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens,
          };
          if (!known) cached.unknown = true;

          if (known && !(key in cache.records)) recordsCounted += 1;
          cache.records[key] = cached;
          cache.refs[key] = (cache.refs[key] ?? 0) + 1;
          entry.keys.push(key);
        }
      }

      entry.processedBytes += consumedBytes;
      entry.size = stat.size;
      entry.mtimeMs = stat.mtimeMs;
    } finally {
      await fh.close();
    }
  }

  for (const filePath of Object.keys(cache.files)) {
    if (!liveFiles.has(filePath)) {
      releaseKeys(cache, cache.files[filePath].keys);
      delete cache.files[filePath];
    }
  }

  let totalCostUSD = 0;
  const perModel: Record<string, number> = {};
  const unknownModels: Record<string, UnknownModelStats> = {};
  for (const rec of Object.values(cache.records)) {
    const id = cache.models[rec.model];
    if (rec.unknown) {
      const stats = (unknownModels[id] ??= { records: 0, tokens: 0 });
      stats.records += 1;
      stats.tokens += rec.tokens;
    } else {
      totalCostUSD += rec.cost;
      perModel[id] = (perModel[id] ?? 0) + rec.cost;
    }
  }

  return {
    totalCostUSD,
    perModel,
    unknownModels,
    partial: Object.keys(unknownModels).length > 0,
    cache,
    filesScanned: files.length,
    recordsCounted,
  };
}

export interface SessionCostResult {
  cost: number;
  /** model ids that passed the filter but did not resolve -> record count; excluded from `cost` */
  unknownModels: Record<string, number>;
  partial: boolean;
}

/**
 * Cost of the records in one transcript's lines (deduped by messageId::requestId).
 * Unresolvable models are reported rather than silently dropped.
 */
export function computeSessionCost(
  lines: string[],
  opts: TranscriptFilterOptions & { registry: Record<string, ModelPricing> },
): SessionCostResult {
  const seen = new Set<string>();
  const unknownModels: Record<string, number> = {};
  let total = 0;
  for (const line of lines) {
    const record = parseUsageLine(line, opts);
    if (!record) continue;
    const key = record.messageId || record.requestId ? `${record.messageId ?? ''}::${record.requestId ?? ''}` : null;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const resolved = resolveModel(opts.registry, record.model);
    if (!resolved) {
      unknownModels[record.model] = (unknownModels[record.model] ?? 0) + 1;
      continue;
    }
    total += computeTurnCost(record.usage, resolved.entry, record.timestamp ?? new Date().toISOString()).cost;
  }
  return { cost: total, unknownModels, partial: Object.keys(unknownModels).length > 0 };
}
