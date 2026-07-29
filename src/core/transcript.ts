import { TurnUsage } from './pricing';
import { isTrackedModel } from './resolve';

/** A single normalized, filtered usage record extracted from a Claude Code transcript line. */
export interface UsageRecord {
  model: string;
  usage: TurnUsage;
  timestamp: string | null;
  cwd: string | null;
  sessionId: string | null;
  /** Claude Code's own message id, used for cross-file/session dedup. */
  messageId: string | null;
  requestId: string | null;
  isSidechain: boolean;
  /** Reasoning effort ("low"/"medium"/"high") Claude Code recorded for this turn, if any. */
  effort: string | null;
}

export interface TranscriptFilterOptions {
  modelPattern: string;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

interface RawLine {
  type?: string;
  isApiErrorMessage?: boolean;
  isSidechain?: boolean;
  cwd?: string;
  sessionId?: string;
  timestamp?: string;
  requestId?: string;
  /** Top-level sibling of `message`, not nested inside it. */
  effort?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: RawUsage;
  };
}

function toTurnUsage(raw: RawUsage): TurnUsage {
  const cacheCreation = raw.cache_creation;
  // Older transcripts have no `cache_creation` breakdown at all — treat the
  // flat `cache_creation_input_tokens` as 5-minute (the historical default)
  // rather than silently dropping it from cost/context accounting.
  const cacheWrite5m = cacheCreation
    ? cacheCreation.ephemeral_5m_input_tokens ?? 0
    : raw.cache_creation_input_tokens ?? 0;
  const cacheWrite1h = cacheCreation?.ephemeral_1h_input_tokens ?? 0;

  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheReadTokens: raw.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: cacheWrite5m,
    cacheWrite1hTokens: cacheWrite1h,
  };
}

/**
 * Parse one JSONL line into a UsageRecord, or return null if the line
 * should not count toward context/cost at all.
 *
 * Rejects, in order:
 *  - not JSON / wrong `type` / no usage payload
 *  - `isApiErrorMessage: true`
 *  - model id that doesn't match the configured filter pattern (default
 *    `^claude-`) — this is what excludes Claude Code's own `<synthetic>`
 *    zero-token bookkeeping records, which otherwise tanked the cache-hit
 *    reading to 0% and painted the status bar red/black.
 *  - all-zero usage (defensive: covers any other zero-token synthetic shape)
 */
export function parseUsageLine(line: string, opts: TranscriptFilterOptions): UsageRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let raw: RawLine;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (raw.type !== 'assistant') return null;
  if (raw.isApiErrorMessage === true) return null;

  const msg = raw.message;
  if (!msg || !msg.usage) return null;

  const model = msg.model ?? '';
  if (!isTrackedModel(model, opts.modelPattern)) return null;

  const usage = toTurnUsage(msg.usage);
  const total =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWrite5mTokens +
    usage.cacheWrite1hTokens;
  if (total <= 0) return null;

  return {
    model,
    usage,
    timestamp: raw.timestamp ?? null,
    cwd: raw.cwd ?? null,
    sessionId: raw.sessionId ?? null,
    messageId: msg.id ?? null,
    requestId: raw.requestId ?? null,
    isSidechain: raw.isSidechain === true,
    effort: raw.effort ?? null,
  };
}

/**
 * Scan a buffer of JSONL text (typically the tail of a file) from the end
 * and return the first record that passes the filters — i.e. the most
 * recent valid turn.
 */
export function findLastUsageRecord(text: string, opts: TranscriptFilterOptions): UsageRecord | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const record = parseUsageLine(lines[i], opts);
    if (record) return record;
  }
  return null;
}
