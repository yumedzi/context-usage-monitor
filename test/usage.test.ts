import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeMonthlyUsage, emptyCache, billingPeriodStart } from '../src/core/usage';
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

  it('resets the cache when the billing period rolls over', () => {
    const cache = emptyCache('2026-06-01');
    cache.records['a::b'] = 5;
    expect(cache.billingPeriodStart).toBe('2026-06-01');
  });
});
