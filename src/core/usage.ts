import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { parseUsageLine, TranscriptFilterOptions } from './transcript';
import { resolveModel } from './resolve';
import { computeTurnCost } from './pricing';
import { ModelPricing } from './models';

export interface FileCacheEntry {
  size: number;
  mtimeMs: number;
  /** bytes from the start of the file already parsed (always ends on a line boundary) */
  processedBytes: number;
  /** dedupe keys this file has contributed, so a shrink/rewrite can be cleanly undone */
  keys: string[];
}

export interface MonthlyUsageCache {
  /** ISO date (YYYY-MM-DD) the current billing period started on */
  billingPeriodStart: string;
  files: Record<string, FileCacheEntry>;
  /** dedupe key -> cost contribution in USD */
  records: Record<string, number>;
}

export function emptyCache(periodStart: string): MonthlyUsageCache {
  return { billingPeriodStart: periodStart, files: {}, records: {} };
}

/** Compute the ISO date (YYYY-MM-DD) the current billing period starts on, given an anchor day-of-month (1-28). */
export function billingPeriodStart(now: Date, anchorDay: number): string {
  const day = Math.min(Math.max(Math.floor(anchorDay), 1), 28);
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const start = d >= day ? new Date(y, m, day) : new Date(y, m - 1, day);
  return toISODate(start);
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function withinPeriod(timestamp: string | null, periodStartISODate: string, now: Date): boolean {
  if (!timestamp) return false;
  const t = new Date(timestamp).getTime();
  if (Number.isNaN(t)) return false;
  const start = new Date(`${periodStartISODate}T00:00:00`).getTime();
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
  now?: Date;
}

export interface MonthlyUsageResult {
  totalCostUSD: number;
  cache: MonthlyUsageCache;
  filesScanned: number;
  recordsCounted: number;
}

let dedupeFallbackCounter = 0;

/** Composite dedupe key for a record. Falls back to a per-call unique counter for the rare record with neither id, so it's still counted (never silently merged into an unrelated record). */
function dedupeKey(messageId: string | null, requestId: string | null): string {
  if (messageId || requestId) return `${messageId ?? ''}::${requestId ?? ''}`;
  dedupeFallbackCounter += 1;
  return `__nokey__${dedupeFallbackCounter}`;
}

/**
 * Compute (and incrementally update) the total $ cost of Claude Code usage
 * across every project directory, for the current billing period.
 *
 * Reuses `previousCache` and reads only newly appended bytes on repeat
 * calls; a file that shrank or was rewritten (mtime moved backwards, or
 * size dropped) is detected and fully rescanned. Measured cold-scan cost
 * on a real ~270MB / 220-file `~/.claude/projects` tree: well under a
 * second — the incremental path is a steady-state optimization, not a
 * correctness requirement.
 */
export async function computeMonthlyUsage(
  projectsDir: string,
  previousCache: MonthlyUsageCache | undefined,
  opts: MonthlyUsageOptions,
): Promise<MonthlyUsageResult> {
  const now = opts.now ?? new Date();
  const periodStart = billingPeriodStart(now, opts.billingCycleStartDay);
  const cache: MonthlyUsageCache =
    previousCache && previousCache.billingPeriodStart === periodStart
      ? previousCache
      : emptyCache(periodStart);

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
      if (entry) {
        for (const key of entry.keys) delete cache.records[key];
      }
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
        for (const line of usableText.split('\n')) {
          const record = parseUsageLine(line, opts);
          if (!record) continue;
          if (!withinPeriod(record.timestamp, periodStart, now)) continue;

          const resolved = resolveModel(opts.registry, record.model);
          const { cost, known } = computeTurnCost(
            record.usage,
            resolved?.entry ?? null,
            record.timestamp ?? toISODate(now),
          );
          if (!known) continue;

          const key = dedupeKey(record.messageId, record.requestId);
          if (!(key in cache.records)) {
            entry.keys.push(key);
            recordsCounted += 1;
          }
          cache.records[key] = cost;
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
      for (const key of cache.files[filePath].keys) delete cache.records[key];
      delete cache.files[filePath];
    }
  }

  const totalCostUSD = Object.values(cache.records).reduce((a, b) => a + b, 0);
  return { totalCostUSD, cache, filesScanned: files.length, recordsCounted };
}
