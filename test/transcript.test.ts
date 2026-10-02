import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseUsageLine, findLastUsageRecord } from '../src/core/transcript';
import { DEFAULT_MODEL_PATTERN } from '../src/core/resolve';

const opts = { modelPattern: '^claude-' };
const fixturesDir = path.join(__dirname, 'fixtures');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

describe('parseUsageLine', () => {
  it('rejects <synthetic> records (RC2)', () => {
    const lines = readFixture('synthetic.jsonl').trim().split('\n');
    expect(parseUsageLine(lines[0], opts)).not.toBeNull();
    expect(parseUsageLine(lines[1], opts)).toBeNull();
  });

  it('rejects non-assistant, malformed JSON, and all-zero-usage lines', () => {
    expect(parseUsageLine('not json', opts)).toBeNull();
    expect(parseUsageLine('', opts)).toBeNull();
    expect(parseUsageLine(JSON.stringify({ type: 'user', message: { model: 'claude-sonnet-5', usage: { input_tokens: 5 } } }), opts)).toBeNull();
    expect(
      parseUsageLine(
        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 0, output_tokens: 0 } } }),
        opts,
      ),
    ).toBeNull();
  });

  it('rejects isApiErrorMessage records', () => {
    const line = JSON.stringify({
      type: 'assistant',
      isApiErrorMessage: true,
      message: { model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 10 } },
    });
    expect(parseUsageLine(line, opts)).toBeNull();
  });

  it('parses the 1h cache-write breakdown separately from 5m (RC4 data path)', () => {
    const line = readFixture('cache-1h.jsonl').trim();
    const record = parseUsageLine(line, opts);
    expect(record?.usage.cacheWrite1hTokens).toBe(381);
    expect(record?.usage.cacheWrite5mTokens).toBe(0);
  });

  it('parses a dated model id through as-is (resolution happens in resolve.ts)', () => {
    const line = readFixture('dated-model.jsonl').trim();
    const record = parseUsageLine(line, opts);
    expect(record?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('parses the top-level effort field, sibling of message (not nested)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      effort: 'high',
      message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 10 } },
    });
    expect(parseUsageLine(line, opts)?.effort).toBe('high');
  });

  it('defaults effort to null when absent', () => {
    const line = readFixture('dated-model.jsonl').trim();
    expect(parseUsageLine(line, opts)?.effort).toBeNull();
  });
});

describe('parseUsageLine: speed / geo / web search', () => {
  const mk = (usage: Record<string, unknown>) =>
    JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5, ...usage } } });

  it('extracts speed, inference_geo and web_search_requests', () => {
    const r = parseUsageLine(mk({ speed: 'fast', inference_geo: 'us', server_tool_use: { web_search_requests: 2 } }), opts);
    expect(r?.usage.speed).toBe('fast');
    expect(r?.usage.inferenceGeo).toBe('us');
    expect(r?.usage.webSearchRequests).toBe(2);
  });

  it('defaults to null/0 when absent', () => {
    const r = parseUsageLine(mk({}), opts);
    expect(r?.usage.speed).toBeNull();
    expect(r?.usage.inferenceGeo).toBeNull();
    expect(r?.usage.webSearchRequests).toBe(0);
  });

  it('accepts Bedrock-style model ids with the default pattern', () => {
    const line = JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'us.anthropic.claude-sonnet-5-v1:0', usage: { input_tokens: 1 } } });
    expect(parseUsageLine(line, { modelPattern: DEFAULT_MODEL_PATTERN })?.model).toBe('us.anthropic.claude-sonnet-5-v1:0');
  });
});

describe('findLastUsageRecord', () => {
  it('walks from the end and skips the trailing <synthetic> record', () => {
    const record = findLastUsageRecord(readFixture('synthetic.jsonl'), opts);
    expect(record?.model).toBe('claude-sonnet-5');
    expect(record?.messageId).toBe('msg-1');
  });
});
