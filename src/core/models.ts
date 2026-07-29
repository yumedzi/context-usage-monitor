/**
 * Built-in model registry: pricing ($/token) and context window sizes.
 * No network access — the upstream extension scraped platform.claude.com,
 * which produced keys like "claude-sonnet-5-through-august-31,-2026" that
 * never match the plain "claude-sonnet-5" model id Claude Code sends. That
 * single miss caused both the wrong 200K context reading and the "$?" cost.
 *
 * Source: Anthropic pricing docs, snapshot 2026-07-29. Kept in code (not
 * fetched) so it never silently degrades; users can override via the
 * `pricing.models` / `contextWindowOverrides` settings.
 */

export interface ModelPricing {
  /** $ per input token */
  input: number;
  /** $ per output token */
  output: number;
  /** $ per cache-read token (~0.1x input) */
  cacheRead: number;
  /** $ per cache-write token, 5-minute TTL (~1.25x input) */
  cacheWrite5m: number;
  /** $ per cache-write token, 1-hour TTL (~2x input) */
  cacheWrite1h: number;
  /** context window size in tokens */
  contextWindow: number;
  /** optional time-boxed introductory pricing that supersedes the above */
  introPrice?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    /** ISO date (inclusive) after which introPrice no longer applies */
    until: string;
  };
}

// Documented cache-pricing multipliers, relative to input price.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

function derive(input: number, output: number, contextWindow: number): ModelPricing {
  return {
    input,
    output,
    cacheRead: input * CACHE_READ_MULTIPLIER,
    cacheWrite5m: input * CACHE_WRITE_5M_MULTIPLIER,
    cacheWrite1h: input * CACHE_WRITE_1H_MULTIPLIER,
    contextWindow,
  };
}

// All prices are $ per token (MTok price / 1_000_000).
const PER_MTOK = 1_000_000;
function fromMTok(inputPerMTok: number, outputPerMTok: number, contextWindow: number): ModelPricing {
  return derive(inputPerMTok / PER_MTOK, outputPerMTok / PER_MTOK, contextWindow);
}

export const DEFAULT_MODEL_REGISTRY: Record<string, ModelPricing> = {
  'claude-fable-5': fromMTok(10, 50, 1_000_000),
  'claude-mythos-5': fromMTok(10, 50, 1_000_000),
  'claude-opus-5': fromMTok(5, 25, 1_000_000),
  'claude-opus-4-8': fromMTok(5, 25, 1_000_000),
  'claude-opus-4-7': fromMTok(5, 25, 1_000_000),
  'claude-opus-4-6': fromMTok(5, 25, 1_000_000),
  'claude-opus-4-5': fromMTok(5, 25, 1_000_000),
  'claude-opus-4-1': fromMTok(5, 25, 1_000_000),
  'claude-opus-4-0': fromMTok(5, 25, 1_000_000),
  'claude-sonnet-5': {
    ...fromMTok(3, 15, 1_000_000),
    introPrice: {
      input: 2 / PER_MTOK,
      output: 10 / PER_MTOK,
      cacheRead: (2 / PER_MTOK) * CACHE_READ_MULTIPLIER,
      cacheWrite5m: (2 / PER_MTOK) * CACHE_WRITE_5M_MULTIPLIER,
      cacheWrite1h: (2 / PER_MTOK) * CACHE_WRITE_1H_MULTIPLIER,
      until: '2026-08-31',
    },
  },
  'claude-sonnet-4-6': fromMTok(3, 15, 1_000_000),
  'claude-sonnet-4-5': fromMTok(3, 15, 1_000_000),
  'claude-sonnet-4-0': fromMTok(3, 15, 200_000),
  'claude-haiku-4-5': fromMTok(1, 5, 200_000),
  'claude-3-haiku-20240307': fromMTok(0.25, 1.25, 200_000),
};

/**
 * Resolve the effective pricing for a model, honoring intro pricing at a
 * given point in time. `atISODate` may be a bare date ("2026-07-29") or a
 * full timestamp ("2026-07-29T14:03:00Z") — comparison is done on parsed
 * Date values (not string prefix matching) so the intro window's end date
 * is inclusive for its entire calendar day.
 */
export function effectivePricing(entry: ModelPricing, atISODate: string): Omit<ModelPricing, 'introPrice'> {
  if (entry.introPrice) {
    const at = new Date(atISODate).getTime();
    const untilEndOfDay = new Date(`${entry.introPrice.until}T23:59:59.999Z`).getTime();
    if (!Number.isNaN(at) && at <= untilEndOfDay) {
      const { until: _until, ...rest } = entry.introPrice;
      return { ...rest, contextWindow: entry.contextWindow };
    }
  }
  const { introPrice: _introPrice, ...rest } = entry;
  return rest;
}
