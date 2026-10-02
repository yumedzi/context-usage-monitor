import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CACHE_VERSION,
  MonthlyUsageCache,
  billingPeriodStart,
  computeMonthlyUsage,
  computeSessionCost,
  isCurrentCache,
  withinPeriod,
} from '../src/core/usage';
import { DEFAULT_MODEL_REGISTRY } from '../src/core/models';

const registry = DEFAULT_MODEL_REGISTRY;
const now = new Date('2026-07-29T15:00:00.000Z');
const baseOpts = { registry, modelPattern: '^claude-', billingCycleStartDay: 1, now };

let projectsDir: string;

beforeEach(() => {
  projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cum-usage-test-'));
});

afterEach(() => {
  fs.rmSync(projectsDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): string {
  const full = path.join(projectsDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe('billingPeriodStart', () => {
  it('uses the current month when the anchor day has already passed', () => {
    expect(billingPeriodStart(new Date('2026-07-29'), 1)).toBe('2026-07-01');
  });

  it('rolls back to the previous month before the anchor day', () => {
    expect(billingPeriodStart(new Date('2026-07-05'), 15)).toBe('2026-06-15');
  });

  it('clamps an out-of-range anchor day to [1,28]', () => {
    expect(billingPeriodStart(new Date('2026-07-29'), 31)).toBe('2026-07-28');
  });
});

describe('computeMonthlyUsage', () => {
  it('dedupes repeated records sharing the same messageId::requestId (resumed sessions)', async () => {
    const dedupeContent = fs.readFileSync(path.join(__dirname, 'fixtures', 'dedupe.jsonl'), 'utf8');
    writeFile('proj-a/session.jsonl', dedupeContent);

    const result = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    // 3 lines, but lines 1 & 2 share a dedupe key -> only 2 distinct records counted.
    expect(result.recordsCounted).toBe(2);
    expect(result.totalCostUSD).toBeGreaterThan(0);
  });

  it('excludes unresolved models from the total (never guesses a price)', async () => {
    const unknownContent = fs.readFileSync(path.join(__dirname, 'fixtures', 'unknown-model.jsonl'), 'utf8');
    writeFile('proj-b/session.jsonl', unknownContent);

    const result = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    expect(result.totalCostUSD).toBe(0);
    expect(result.recordsCounted).toBe(0);
  });

  it('excludes <synthetic> records via the model filter', async () => {
    const syntheticContent = fs.readFileSync(path.join(__dirname, 'fixtures', 'synthetic.jsonl'), 'utf8');
    writeFile('proj-c/session.jsonl', syntheticContent);

    const result = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    expect(result.recordsCounted).toBe(1); // only the real claude-sonnet-5 line
  });

  it('finds files recursively, not just one level deep', async () => {
    const content = fs.readFileSync(path.join(__dirname, 'fixtures', 'dated-model.jsonl'), 'utf8');
    writeFile('proj-d/nested/deep/session.jsonl', content);

    const result = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    expect(result.filesScanned).toBe(1);
    expect(result.recordsCounted).toBe(1);
  });

  it('incrementally reads only appended bytes on a second call', async () => {
    const line1 = fs.readFileSync(path.join(__dirname, 'fixtures', 'dated-model.jsonl'), 'utf8');
    const file = writeFile('proj-e/session.jsonl', line1);

    const first = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    expect(first.recordsCounted).toBe(1);

    const line2 = fs.readFileSync(path.join(__dirname, 'fixtures', 'unknown-model.jsonl'), 'utf8');
    fs.appendFileSync(file, line2);
    // bump mtime forward so the incremental check does not treat this as unchanged
    const stat = fs.statSync(file);
    fs.utimesSync(file, new Date(), new Date(stat.mtimeMs + 1000));

    const second = await computeMonthlyUsage(projectsDir, first.cache, baseOpts);
    // unknown-model line contributes 0 cost but is still a new byte range scanned;
    // total should be unchanged from the first (known) record's cost.
    expect(second.totalCostUSD).toBeCloseTo(first.totalCostUSD);
  });

  it('fully rescans a file that shrank or was rewritten', async () => {
    const original = fs.readFileSync(path.join(__dirname, 'fixtures', 'dedupe.jsonl'), 'utf8');
    const file = writeFile('proj-f/session.jsonl', original);

    const first = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    const firstTotal = first.totalCostUSD;
    expect(firstTotal).toBeGreaterThan(0);

    // Simulate a rewrite: shrink to just the first line, mtime moved backward semantics
    // are detected via size shrinking even if mtime also changes.
    const firstLineOnly = original.split('\n')[0] + '\n';
    fs.writeFileSync(file, firstLineOnly);

    const second = await computeMonthlyUsage(projectsDir, first.cache, baseOpts);
    expect(second.totalCostUSD).toBeLessThan(firstTotal);
    expect(second.totalCostUSD).toBeGreaterThan(0);
  });

  it('discards the cache when the billing period rolls over', async () => {
    const content = fs.readFileSync(path.join(__dirname, 'fixtures', 'dated-model.jsonl'), 'utf8');
    writeFile('proj-g/session.jsonl', content);
    const first = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    expect(first.cache.billingPeriodStart).toBe('2026-07-01');
    const next = await computeMonthlyUsage(projectsDir, first.cache, { ...baseOpts, now: new Date('2026-08-02T00:00:00Z') });
    expect(next.cache.billingPeriodStart).toBe('2026-08-01');
    expect(next.totalCostUSD).toBe(0); // July record is outside the August period
  });
});

describe('computeMonthlyUsage: mixed models, unknowns, per-model', () => {
  const mixed = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'mixed-models.jsonl'), 'utf8');

  it('prices opus-5-5 and sonnet-5-5 exactly and reports per-model cost', async () => {
    writeFile('proj-m/session.jsonl', mixed());
    const r = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    expect(r.perModel['claude-opus-5-5']).toBeCloseTo(6.4); // 1M in @4 + 0.1M out @20 + 2M cache read @0.20
    expect(r.perModel['claude-sonnet-5-5']).toBeCloseTo(3.2); // 1M @2 + 0.1M @10 + 1M cache read @0.20
    expect(r.totalCostUSD).toBeCloseTo(9.6);
    expect(r.recordsCounted).toBe(2);
  });

  it('reports claude-* ids missing from the registry as unknown (record count + tokens) and marks the total partial', async () => {
    writeFile('proj-m/session.jsonl', mixed());
    const r = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    expect(r.partial).toBe(true);
    expect(r.unknownModels).toEqual({
      'claude-opus-5-9': { records: 2, tokens: 4400 + 1100 },
      'claude-future-1': { records: 1, tokens: 770 },
    });
  });

  it('does not report aliases ("sonnet"), non-Claude strings or <synthetic> as unknown — the model filter drops them', async () => {
    writeFile('proj-m/session.jsonl', mixed());
    const r = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    expect(Object.keys(r.unknownModels).sort()).toEqual(['claude-future-1', 'claude-opus-5-9']);
  });

  it('a user-widened modelPattern surfaces aliases as unknown instead of dropping them', async () => {
    writeFile('proj-m/session.jsonl', mixed());
    const r = await computeMonthlyUsage(projectsDir, undefined, { ...baseOpts, modelPattern: '^(claude-|sonnet|opus)' });
    expect(r.unknownModels['sonnet']).toEqual({ records: 2, tokens: 8800 });
    expect(r.unknownModels['opus']).toEqual({ records: 1, tokens: 2200 });
    expect(r.unknownModels['gpt-4o']).toBeUndefined();
  });

  it('is not partial when everything resolves', async () => {
    const content = fs.readFileSync(path.join(__dirname, 'fixtures', 'dated-model.jsonl'), 'utf8');
    writeFile('proj-n/session.jsonl', content);
    const r = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    expect(r.partial).toBe(false);
    expect(r.unknownModels).toEqual({});
  });

  it('un-partials after the user registers the missing model (cache invalidated by registry change)', async () => {
    writeFile('proj-m/session.jsonl', mixed());
    const first = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    const registry2 = { ...registry, 'claude-opus-5-9': registry['claude-opus-5'], 'claude-future-1': registry['claude-opus-5'] };
    const second = await computeMonthlyUsage(projectsDir, first.cache, { ...baseOpts, registry: registry2 });
    expect(second.partial).toBe(false);
    expect(second.perModel['claude-opus-5-9']).toBeGreaterThan(0);
    expect(second.totalCostUSD).toBeGreaterThan(first.totalCostUSD);
  });

  it('applies fast-mode, geo and web-search extras from the transcript', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-29T10:00:00.000Z',
      requestId: 'r1',
      message: {
        id: 'm1',
        model: 'claude-opus-5-5',
        usage: { input_tokens: 1_000_000, output_tokens: 0, speed: 'fast', inference_geo: 'us', server_tool_use: { web_search_requests: 5 } },
      },
    });
    writeFile('proj-x/session.jsonl', line + '\n');
    const r = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    expect(r.totalCostUSD).toBeCloseTo(4 * 2 * 1.1 + 0.05);
  });
});

describe('computeMonthlyUsage: cache lifecycle', () => {
  const dedupe = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'dedupe.jsonl'), 'utf8');

  it('discards a cache with a different cacheVersion and rescans', async () => {
    writeFile('proj-v/session.jsonl', dedupe());
    const first = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    expect(first.cache.cacheVersion).toBe(CACHE_VERSION);

    // Poison the cache as an old version with bogus (wrong-price) costs.
    const stale = JSON.parse(JSON.stringify(first.cache)) as MonthlyUsageCache;
    stale.cacheVersion = CACHE_VERSION - 1;
    for (const rec of Object.values(stale.records)) rec.cost = 999;

    const second = await computeMonthlyUsage(projectsDir, stale, baseOpts);
    expect(second.totalCostUSD).toBeCloseTo(first.totalCostUSD);
    expect(isCurrentCache(stale)).toBe(false);
    expect(isCurrentCache(second.cache)).toBe(true);
  });

  it('discards a legacy cache with no cacheVersion field at all', async () => {
    writeFile('proj-v/session.jsonl', dedupe());
    const legacy = { billingPeriodStart: '2026-07-01', files: {}, records: { 'a::b': 5 } } as unknown as MonthlyUsageCache;
    const r = await computeMonthlyUsage(projectsDir, legacy, baseOpts);
    expect(r.cache.records['a::b']).toBeUndefined();
    expect(r.totalCostUSD).toBeGreaterThan(0);
  });

  it('keeps a record shared by two files when the file that first contributed it is deleted', async () => {
    const shared = dedupe();
    const a = writeFile('proj-a/a.jsonl', shared);
    writeFile('proj-b/b.jsonl', shared);

    const first = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    expect(first.recordsCounted).toBe(2);
    const total = first.totalCostUSD;
    expect(total).toBeGreaterThan(0);

    fs.rmSync(a);
    const second = await computeMonthlyUsage(projectsDir, first.cache, baseOpts);
    expect(second.totalCostUSD).toBeCloseTo(total);

    fs.rmSync(path.join(projectsDir, 'proj-b', 'b.jsonl'));
    const third = await computeMonthlyUsage(projectsDir, second.cache, baseOpts);
    expect(third.totalCostUSD).toBe(0);
    expect(Object.keys(third.cache.records)).toHaveLength(0);
    expect(Object.keys(third.cache.refs)).toHaveLength(0);
  });

  it('counts a record only once when two files share it, and equals a single file total', async () => {
    const shared = dedupe();
    writeFile('proj-a/a.jsonl', shared);
    const single = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    writeFile('proj-b/b.jsonl', shared);
    const double = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    expect(double.totalCostUSD).toBeCloseTo(single.totalCostUSD);
  });

  it('gives records without any id a stable, unique key (no collision across cache reloads)', async () => {
    const mk = (ts: string) =>
      JSON.stringify({ type: 'assistant', timestamp: ts, message: { model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000 } } });
    const file = writeFile('proj-k/s.jsonl', mk('2026-07-29T10:00:00.000Z') + '\n' + mk('2026-07-29T11:00:00.000Z') + '\n');
    const first = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    expect(first.totalCostUSD).toBeCloseTo(4);
    // simulate restart: JSON round-trip, append another id-less record in the same file
    const reloaded = JSON.parse(JSON.stringify(first.cache)) as MonthlyUsageCache;
    fs.appendFileSync(file, mk('2026-07-29T12:00:00.000Z') + '\n');
    const st = fs.statSync(file);
    fs.utimesSync(file, new Date(), new Date(st.mtimeMs + 1000));
    const second = await computeMonthlyUsage(projectsDir, reloaded, baseOpts);
    expect(second.totalCostUSD).toBeCloseTo(6);
  });
});

describe('billing period time zone', () => {
  it('billingPeriodStart: local vs utc around midnight UTC', () => {
    const t = new Date('2026-09-01T00:30:00Z');
    expect(billingPeriodStart(t, 1, 'utc')).toBe('2026-09-01');
    const t2 = new Date('2026-08-31T23:30:00Z');
    expect(billingPeriodStart(t2, 1, 'utc')).toBe('2026-08-01');
  });

  it('billingPeriodStart rolls back across a year boundary in utc', () => {
    expect(billingPeriodStart(new Date('2026-01-05T12:00:00Z'), 15, 'utc')).toBe('2025-12-15');
  });

  it('withinPeriod (utc) includes 00:00:00Z of the start day and excludes the second before', () => {
    const now = new Date('2026-09-30T23:59:59Z');
    expect(withinPeriod('2026-09-01T00:00:00.000Z', '2026-09-01', now, 'utc')).toBe(true);
    expect(withinPeriod('2026-08-31T23:59:59.999Z', '2026-09-01', now, 'utc')).toBe(false);
  });

  it('withinPeriod rejects future and invalid timestamps', () => {
    const now = new Date('2026-09-10T00:00:00Z');
    expect(withinPeriod('2026-09-11T00:00:00Z', '2026-09-01', now, 'utc')).toBe(false);
    expect(withinPeriod('garbage', '2026-09-01', now, 'utc')).toBe(false);
    expect(withinPeriod(null, '2026-09-01', now, 'utc')).toBe(false);
  });

  it('computeMonthlyUsage utc period: a record just before UTC midnight of the 1st is excluded', async () => {
    const mk = (ts: string, id: string) =>
      JSON.stringify({ type: 'assistant', timestamp: ts, requestId: id, message: { id, model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000 } } });
    writeFile('p/s.jsonl', [mk('2026-08-31T23:59:59.000Z', 'a'), mk('2026-09-01T00:00:01.000Z', 'b')].join('\n') + '\n');
    const r = await computeMonthlyUsage(projectsDir, undefined, {
      ...baseOpts,
      billingCycleTimeZone: 'utc',
      now: new Date('2026-09-30T23:59:59Z'),
    });
    expect(r.cache.billingPeriodStart).toBe('2026-09-01');
    expect(r.totalCostUSD).toBeCloseTo(2); // only record "b" at $2/MTok
  });

  it('switching time zone invalidates the cache', async () => {
    writeFile('p/s.jsonl', fs.readFileSync(path.join(__dirname, 'fixtures', 'dedupe.jsonl'), 'utf8'));
    const local = await computeMonthlyUsage(projectsDir, undefined, baseOpts);
    const utc = await computeMonthlyUsage(projectsDir, local.cache, { ...baseOpts, billingCycleTimeZone: 'utc' });
    expect(utc.cache).not.toBe(local.cache);
  });
});

describe('computeSessionCost', () => {
  it('prices known models, dedupes, and reports unknown ids instead of dropping them silently', () => {
    const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'mixed-models.jsonl'), 'utf8').split('\n');
    const r = computeSessionCost([...lines, ...lines], { registry, modelPattern: '^claude-' });
    expect(r.partial).toBe(true);
    expect(r.unknownModels).toEqual({ 'claude-opus-5-9': 2, 'claude-future-1': 1 });
    expect(r.cost).toBeCloseTo(9.6);
  });
});
